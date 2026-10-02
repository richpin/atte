//! Rust-owned agent records. Schema changes and catalog replacement are transactional.
use crate::{
    agent::AgentDefinition,
    agent_management::registry::{Registry, RegistryAgent},
    thread::{QueuedMessage, ThreadMetadata},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
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
    pub(crate) installation_identity: Option<crate::installation::Identity>,
    pub pending: Option<Installation>,
    pub(crate) pending_identity: Option<crate::installation::Identity>,
    pub pending_artifact: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error(
        "앱 정보를 저장하거나 불러올 수 없습니다. 앱 저장 폴더의 권한과 여유 공간을 확인해주세요."
    )]
    Database(#[from] rusqlite::Error),
    #[error("저장 정보 형식을 읽을 수 없습니다.")]
    Data(#[from] serde_json::Error),
    #[error("저장 정보의 식별자를 읽을 수 없습니다.")]
    Identifier(#[from] uuid::Error),
    #[error("저장 정보의 숫자를 읽거나 쓸 수 없습니다.")]
    Integer(#[from] std::num::TryFromIntError),
    #[error("저장 정보의 경로를 읽거나 쓸 수 없습니다.")]
    Path,
    #[error("더 새로운 앱의 저장소입니다. 앱을 업데이트해주세요.")]
    NewerSchema,
    #[error("저장소를 사용할 수 없습니다.")]
    Unavailable,
}

pub struct Store {
    connection: Mutex<Connection>,
    root: PathBuf,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let transaction = connection.transaction()?;
        let version: u32 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > 1 {
            return Err(StorageError::NewerSchema);
        }
        if version == 0 {
            transaction.execute_batch(include_str!("../schema.sql"))?;
        }
        transaction.commit()?;
        Ok(Self {
            connection: Mutex::new(connection),
            root: path.parent().unwrap_or(Path::new(".")).to_owned(),
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn threads(&self) -> Result<Vec<ThreadMetadata>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::Unavailable)?;
        let mut statement = connection.prepare(
            "SELECT id, title, working_folder, agent_id, session_id, created_at, updated_at, last_prompt_at, status, failure, interrupted FROM threads",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, bool>(10)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                title,
                working_folder,
                agent_id,
                session_id,
                created_at,
                updated_at,
                last_prompt_at,
                status,
                failure,
                interrupted,
            ) = row?;
            Ok(ThreadMetadata {
                id: uuid::Uuid::parse_str(&id)?,
                title,
                working_folder: PathBuf::from(working_folder),
                agent_id,
                session_id,
                created_at: u64::try_from(created_at)?,
                updated_at: u64::try_from(updated_at)?,
                last_prompt_at: last_prompt_at.map(u64::try_from).transpose()?,
                status: decode_enum(status)?,
                failure: failure.map(decode_enum).transpose()?,
                completed_turn_id: None,
                request_failure: None,
                interrupted,
            })
        })
        .collect()
    }

    pub(crate) fn queued_messages(
        &self,
        id: uuid::Uuid,
    ) -> Result<Vec<QueuedMessage>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::Unavailable)?;
        let json: Option<String> = connection
            .query_row(
                "SELECT queued_messages FROM threads WHERE id=?1",
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
        id: uuid::Uuid,
        messages: &[QueuedMessage],
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::Unavailable)?;
        let changed = connection.execute(
            "UPDATE threads SET queued_messages=?2 WHERE id=?1",
            params![id.to_string(), serde_json::to_string(messages)?],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows.into());
        }
        Ok(())
    }

    pub(crate) fn save_thread(&self, metadata: &ThreadMetadata) -> Result<(), StorageError> {
        let status = encode_enum(&metadata.status)?;
        let failure = metadata.failure.as_ref().map(encode_enum).transpose()?;
        let created_at = i64::try_from(metadata.created_at)?;
        let updated_at = i64::try_from(metadata.updated_at)?;
        let last_prompt_at = metadata.last_prompt_at.map(i64::try_from).transpose()?;
        let working_folder = metadata.working_folder.to_str().ok_or(StorageError::Path)?;
        self.connection
            .lock()
            .map_err(|_| StorageError::Unavailable)?
            .execute(
                "INSERT INTO threads (id, title, working_folder, agent_id, session_id, created_at, updated_at, last_prompt_at, status, failure, interrupted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(id) DO UPDATE SET title=excluded.title, working_folder=excluded.working_folder, agent_id=excluded.agent_id, session_id=excluded.session_id, created_at=excluded.created_at, updated_at=excluded.updated_at, last_prompt_at=excluded.last_prompt_at, status=excluded.status, failure=excluded.failure, interrupted=excluded.interrupted",
                params![
                    metadata.id.to_string(),
                    metadata.title,
                    working_folder,
                    metadata.agent_id,
                    metadata.session_id,
                    created_at,
                    updated_at,
                    last_prompt_at,
                    status,
                    failure,
                    metadata.interrupted,
                ],
            )?;
        Ok(())
    }

    pub(crate) fn delete_thread(&self, id: uuid::Uuid) -> Result<(), StorageError> {
        self.connection
            .lock()
            .map_err(|_| StorageError::Unavailable)?
            .execute("DELETE FROM threads WHERE id=?1", [id.to_string()])?;
        Ok(())
    }

    pub fn agents(&self) -> Result<Vec<StoredAgent>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::Unavailable)?;
        let mut statement = connection.prepare("SELECT id, registry_metadata, installed_version, artifact_path, launch_definition, pending_artifact_path FROM agents ORDER BY id")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?;
        rows.map(|row| {
            let (id, metadata, version, artifact, definition, pending_artifact) = row?;
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
            let installation_identity = installation
                .as_ref()
                .and_then(|item| crate::installation::identity(&item.artifact).ok());
            let pending = pending_artifact.as_deref().and_then(|artifact| {
                crate::installation::load(&self.root, Path::new(artifact), &id).ok()
            });
            let pending_identity = pending
                .as_ref()
                .and_then(|item| crate::installation::identity(&item.artifact).ok());
            Ok(StoredAgent {
                id,
                registry,
                installation,
                installation_identity,
                pending,
                pending_identity,
                pending_artifact: pending_artifact.map(PathBuf::from),
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
        self.connection.lock().map_err(|_| StorageError::Unavailable)?.execute(
            "INSERT INTO agents (id, installed_version, artifact_path, launch_definition) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET installed_version=excluded.installed_version, artifact_path=excluded.artifact_path, launch_definition=excluded.launch_definition",
            params![installation.definition.id, installation.version, installation.artifact.to_string_lossy(), serde_json::to_string(&installation.definition)?])?;
        Ok(())
    }

    /// Replaces the pending selector and returns the previously selected artifact.
    ///
    /// # Errors
    /// Returns an error when the database is unavailable or the update fails.
    pub fn save_pending(
        &self,
        installation: &Installation,
    ) -> Result<Option<PathBuf>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::Unavailable)?;
        let previous: Option<String> = connection
            .query_row(
                "SELECT pending_artifact_path FROM agents WHERE id=?1",
                [&installation.definition.id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        connection.execute(
            "UPDATE agents SET pending_artifact_path=?2 WHERE id=?1",
            params![
                installation.definition.id,
                installation.artifact.to_string_lossy()
            ],
        )?;
        Ok(previous.map(PathBuf::from))
    }

    /// Atomically selects the pending installation as active.
    ///
    /// # Errors
    /// Returns an error when stored agent data cannot be read or the selector transaction fails.
    pub fn promote_pending(
        &self,
        id: &str,
    ) -> Result<Option<(Option<Installation>, Installation)>, StorageError> {
        let agents = self.agents()?;
        let Some(stored) = agents.into_iter().find(|agent| agent.id == id) else {
            return Ok(None);
        };
        let Some(pending) = stored.pending else {
            return Ok(None);
        };
        let previous = stored.installation;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::Unavailable)?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE agents SET installed_version=?2, artifact_path=?3, launch_definition=?4, pending_artifact_path=NULL WHERE id=?1 AND pending_artifact_path=?3",
            params![id, pending.version, pending.artifact.to_string_lossy(), serde_json::to_string(&pending.definition)?],
        )?;
        transaction.commit()?;
        Ok(Some((previous, pending)))
    }

    /// Clears a pending selector without changing the active installation.
    ///
    /// # Errors
    /// Returns an error when the database is unavailable or the update fails.
    pub fn clear_pending(&self, id: &str) -> Result<(), StorageError> {
        self.connection
            .lock()
            .map_err(|_| StorageError::Unavailable)?
            .execute(
                "UPDATE agents SET pending_artifact_path=NULL WHERE id=?1",
                [id],
            )?;
        Ok(())
    }

    /// Called only after installation files have been removed successfully.
    pub fn remove_installation(&self, id: &str) -> Result<(), StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::Unavailable)?;
        let transaction = connection.transaction()?;
        transaction.execute("UPDATE agents SET installed_version=NULL, artifact_path=NULL, pending_artifact_path=NULL, launch_definition=NULL WHERE id=?1", [id])?;
        transaction.execute(
            "DELETE FROM agents WHERE id=?1 AND registry_metadata IS NULL",
            [id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn registry_fetched_at(&self) -> Result<i64, StorageError> {
        let value: Option<String> = self
            .connection
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
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::Unavailable)?;
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

fn encode_enum(value: &impl Serialize) -> Result<String, StorageError> {
    Ok(serde_json::from_value(serde_json::to_value(value)?)?)
}

fn decode_enum<T: DeserializeOwned>(value: String) -> Result<T, StorageError> {
    Ok(serde_json::from_value(serde_json::Value::String(value))?)
}
