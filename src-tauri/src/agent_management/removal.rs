use super::{AgentManagement, ManagementError};
use crate::conversation::{AuthenticationStatus, Conversations};

impl AgentManagement {
    pub async fn uninstall(
        &self,
        id: &str,
        conversations: &Conversations,
    ) -> Result<(), ManagementError> {
        let _operation = self.begin(id)?;
        let installation = self
            .store
            .installations()?
            .into_iter()
            .find(|item| item.definition.id == id)
            .ok_or(ManagementError::Removal)?;
        crate::installation_files::validate(&self.root, &installation.artifact)
            .map_err(|_| ManagementError::Removal)?;
        conversations
            .unregister_agent(id)
            .await
            .map_err(|_| ManagementError::Connection)?;
        self.authentication
            .lock()
            .map_err(|_| ManagementError::Connection)?
            .remove(id);
        conversations.record_authentication(id, AuthenticationStatus::Unknown);
        let root = self.root.clone();
        let artifact = installation.artifact;
        tokio::task::spawn_blocking(move || crate::installation_files::remove(&root, &artifact))
            .await
            .map_err(|_| ManagementError::Removal)?
            .map_err(|_| ManagementError::Removal)?;
        // Keep the installation record on failure, including a crash between file
        // removal and this write. Removing an already missing path is safe to retry.
        self.store.remove_installation(id)?;
        Ok(())
    }
}
