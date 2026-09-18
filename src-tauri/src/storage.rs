//! Rust-owned agent records. Schema changes and catalog replacement are transactional.
use crate::{
    agent::AgentDefinition,
    agent_management::registry::{Registry, RegistryAgent},
    conversation::{ConversationMetadata, QueuedMessage},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Installation {
    pub definition: AgentDefinition,
    pub version: String,
    pub artifact: PathBuf,
}

pub struct StoredAgent {
    pub id: String,
    pub registry: Option<RegistryAgent>,
    pub installation: Option<Installation>,
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error(
        "앱 정보를 저장하거나 불러올 수 없습니다. 앱 저장 폴더의 권한과 여유 공간을 확인해주세요."
    )]
    Database(#[from] rusqlite::Error),
    #[error("저장 정보 형식을 읽을 수 없습니다.")]
    Data(#[from] serde_json::Error),
    #[error("더 새로운 앱의 저장소입니다. 앱을 업데이트해주세요.")]
    NewerSchema,
    #[error("저장소를 사용할 수 없습니다.")]
    Unavailable,
}

pub struct Store(Mutex<Connection>);

impl Store {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let transaction = connection.transaction()?;
        let version: u32 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > 4 {
            return Err(StorageError::NewerSchema);
        }
        if version == 0 {
            transaction.execute_batch(include_str!("../migrations/001_agents.sql"))?;
        }
        if version < 2 {
            transaction.execute_batch(include_str!("../migrations/002_conversations.sql"))?;
        }
        if version < 3 {
            transaction.execute_batch(include_str!("../migrations/003_queued_messages.sql"))?;
        }
        if version < 4 {
            transaction.execute_batch(include_str!(
                "../migrations/004_conversation_queue_column.sql"
            ))?;
        }
        transaction.commit()?;
        Ok(Self(Mutex::new(connection)))
    }

    pub(crate) fn conversations(&self) -> Result<Vec<ConversationMetadata>, StorageError> {
        let connection = self.0.lock().map_err(|_| StorageError::Unavailable)?;
        let mut statement = connection.prepare("SELECT metadata FROM conversations")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub(crate) fn queued_messages(
        &self,
        id: uuid::Uuid,
    ) -> Result<Vec<QueuedMessage>, StorageError> {
        let connection = self.0.lock().map_err(|_| StorageError::Unavailable)?;
        let json: Option<String> = connection
            .query_row(
                "SELECT queued_messages FROM conversations WHERE id=?1",
                [id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| serde_json::from_str(&json).map_err(StorageError::from))
            .transpose()
            .map(Option::unwrap_or_default)
    }

    pub(crate) fn save_queue(
        &self,
        metadata: &ConversationMetadata,
        messages: &[QueuedMessage],
    ) -> Result<(), StorageError> {
        let connection = self.0.lock().map_err(|_| StorageError::Unavailable)?;
        connection.execute("INSERT INTO conversations (id, metadata, queued_messages) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET queued_messages=excluded.queued_messages", params![metadata.id.to_string(), serde_json::to_string(metadata)?, serde_json::to_string(messages)?])?;
        Ok(())
    }

    pub(crate) fn save_conversation(
        &self,
        metadata: &ConversationMetadata,
    ) -> Result<(), StorageError> {
        self.0.lock().map_err(|_| StorageError::Unavailable)?.execute(
            "INSERT INTO conversations (id, metadata) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata",
            params![metadata.id.to_string(), serde_json::to_string(metadata)?],
        )?;
        Ok(())
    }

    pub fn agents(&self) -> Result<Vec<StoredAgent>, StorageError> {
        let connection = self.0.lock().map_err(|_| StorageError::Unavailable)?;
        let mut statement = connection.prepare("SELECT id, registry_metadata, installed_version, artifact_path, launch_definition FROM agents ORDER BY id")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;
        rows.map(|row| {
            let (id, metadata, version, artifact, definition) = row?;
            let installation = match (version, artifact, definition) {
                (Some(version), Some(artifact), Some(definition)) => Some(Installation {
                    version,
                    artifact: artifact.into(),
                    definition: serde_json::from_str(&definition)?,
                }),
                _ => None,
            };
            // Registry metadata is replaceable; bad cached metadata must not prevent
            // restoring a separately persisted, valid installation.
            let registry = metadata.and_then(|json| serde_json::from_str(&json).ok());
            Ok(StoredAgent {
                id,
                registry,
                installation,
            })
        })
        .collect()
    }

    pub fn installations(&self) -> Result<Vec<Installation>, StorageError> {
        Ok(self
            .agents()?
            .into_iter()
            .filter_map(|agent| agent.installation)
            .collect())
    }

    pub fn save_installation(&self, installation: &Installation) -> Result<(), StorageError> {
        self.0.lock().map_err(|_| StorageError::Unavailable)?.execute(
            "INSERT INTO agents (id, installed_version, artifact_path, launch_definition) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET installed_version=excluded.installed_version, artifact_path=excluded.artifact_path, launch_definition=excluded.launch_definition",
            params![installation.definition.id, installation.version, installation.artifact.to_string_lossy(), serde_json::to_string(&installation.definition)?])?;
        Ok(())
    }

    /// Called only after installation files have been removed successfully.
    pub fn remove_installation(&self, id: &str) -> Result<(), StorageError> {
        let mut connection = self.0.lock().map_err(|_| StorageError::Unavailable)?;
        let transaction = connection.transaction()?;
        transaction.execute("UPDATE agents SET installed_version=NULL, artifact_path=NULL, launch_definition=NULL WHERE id=?1", [id])?;
        transaction.execute(
            "DELETE FROM agents WHERE id=?1 AND registry_metadata IS NULL",
            [id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn registry_fetched_at(&self) -> Result<i64, StorageError> {
        let value: Option<String> = self
            .0
            .lock()
            .map_err(|_| StorageError::Unavailable)?
            .query_row(
                "SELECT value FROM app_metadata WHERE key='registry_fetched_at'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value
            .and_then(|value| value.parse().ok())
            .unwrap_or_default())
    }

    pub fn save_registry(&self, registry: &Registry, fetched_at: i64) -> Result<(), StorageError> {
        let mut connection = self.0.lock().map_err(|_| StorageError::Unavailable)?;
        let transaction = connection.transaction()?;
        transaction.execute("UPDATE agents SET registry_metadata=NULL", [])?;
        for agent in &registry.agents {
            transaction.execute("INSERT INTO agents (id, registry_metadata) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET registry_metadata=excluded.registry_metadata", params![agent.id, serde_json::to_string(agent)?])?;
        }
        transaction.execute(
            "DELETE FROM agents WHERE registry_metadata IS NULL AND installed_version IS NULL",
            [],
        )?;
        transaction.execute("INSERT INTO app_metadata (key, value) VALUES ('registry_fetched_at', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [fetched_at.to_string()])?;
        transaction.commit()?;
        Ok(())
    }
}
