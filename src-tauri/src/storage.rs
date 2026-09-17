//! Rust-owned SQLite repository. Each schema change is a transactional migration.
use crate::agent::AgentDefinition;
use rusqlite::{params, Connection};
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

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("설치 정보를 저장하거나 불러올 수 없습니다. 앱 저장 폴더의 권한과 여유 공간을 확인해주세요.")]
    Database(#[from] rusqlite::Error),
    #[error("설치 정보 형식을 읽을 수 없습니다.")]
    Data(#[from] serde_json::Error),
    #[error("더 새로운 앱의 저장소입니다. 앱을 업데이트해주세요.")]
    NewerSchema,
    #[error("저장소를 사용할 수 없습니다. 앱을 다시 실행해주세요.")]
    Unavailable,
}

pub struct Store(Mutex<Connection>);

impl Store {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let transaction = connection.transaction()?;
        let version: u32 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        match version {
            0 => transaction.execute_batch(include_str!("../migrations/001_installations.sql"))?,
            1 => {}
            _ => return Err(StorageError::NewerSchema),
        }
        transaction.commit()?;
        Ok(Self(Mutex::new(connection)))
    }

    pub fn installations(&self) -> Result<Vec<Installation>, StorageError> {
        let connection = self.0.lock().map_err(|_| StorageError::Unavailable)?;
        let mut statement = connection
            .prepare("SELECT version, artifact, definition FROM installations ORDER BY agent_id")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (version, artifact, definition) = row?;
            Ok(Installation {
                version,
                artifact: artifact.into(),
                definition: serde_json::from_str(&definition)?,
            })
        })
        .collect()
    }

    pub fn save_installation(&self, installation: &Installation) -> Result<(), StorageError> {
        let connection = self.0.lock().map_err(|_| StorageError::Unavailable)?;
        connection.execute("INSERT INTO installations (agent_id, version, artifact, definition) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(agent_id) DO UPDATE SET version=excluded.version, artifact=excluded.artifact, definition=excluded.definition",
            params![installation.definition.id, installation.version, installation.artifact.to_string_lossy(), serde_json::to_string(&installation.definition)?])?;
        Ok(())
    }
}
