use super::{AgentManagement, ManagementError};
use crate::thread::{AuthenticationStatus, Threads};

impl AgentManagement {
    pub async fn uninstall(&self, id: &str, threads: &Threads) -> Result<(), ManagementError> {
        let _operation = self.begin_removal(id).await?;
        let stored = self
            .store
            .agents()?
            .into_iter()
            .find(|item| item.id == id)
            .ok_or(ManagementError::Removal)?;
        let mut artifacts: Vec<_> = [stored.installation, stored.pending]
            .into_iter()
            .flatten()
            .map(|installation| installation.artifact)
            .collect();
        if artifacts.is_empty() {
            return Err(ManagementError::Removal);
        }
        for artifact in &artifacts {
            crate::installation_files::validate(&self.root, artifact)
                .map_err(|_| ManagementError::Removal)?;
        }
        threads
            .unregister_agent(id)
            .await
            .map_err(|_| ManagementError::Connection)?;
        self.authentication
            .lock()
            .map_err(|_| ManagementError::Connection)?
            .remove(id);
        threads.record_authentication(id, AuthenticationStatus::Unknown);
        let root = self.root.clone();
        let agent_id = id.to_owned();
        tokio::task::spawn_blocking(move || {
            for artifact in artifacts.drain(..) {
                crate::installation_files::remove(&root, &artifact)?;
            }
            let agent_root = root.join("agents").join(agent_id);
            if agent_root.is_dir() {
                std::fs::remove_dir_all(agent_root)?;
            }
            Ok::<_, std::io::Error>(())
        })
        .await
        .map_err(|_| ManagementError::Removal)?
        .map_err(|_| ManagementError::Removal)?;
        // Keep the installation record on failure, including a crash between file
        // removal and this write. Removing an already missing path is safe to retry.
        self.store.remove_installation(id)?;
        Ok(())
    }
}
