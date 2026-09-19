use super::{mpsc, HashMap, ThreadMetadata, Uuid};

#[derive(Default)]
pub(super) struct ThreadList {
    pub entries: HashMap<Uuid, ThreadMetadata>,
    subscribers: Vec<mpsc::UnboundedSender<Vec<ThreadMetadata>>>,
}

impl ThreadList {
    pub fn sorted_entries(&self) -> Vec<ThreadMetadata> {
        let mut entries: Vec<_> = self.entries.values().cloned().collect();
        entries.sort_by(|a, b| {
            b.last_prompt_at
                .cmp(&a.last_prompt_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        entries
    }

    pub fn publish(&mut self, metadata: ThreadMetadata) {
        self.entries.insert(metadata.id, metadata);
        self.publish_entries();
    }

    pub fn remove(&mut self, id: Uuid) {
        self.entries.remove(&id);
        self.publish_entries();
    }

    fn publish_entries(&mut self) {
        let entries = self.sorted_entries();
        self.subscribers
            .retain(|subscriber| subscriber.send(entries.clone()).is_ok());
    }

    pub fn subscribe(&mut self) -> mpsc::UnboundedReceiver<Vec<ThreadMetadata>> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let _ = sender.send(self.sorted_entries());
        self.subscribers
            .retain(|subscriber| !subscriber.is_closed());
        self.subscribers.push(sender);
        receiver
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thread::ThreadStatus;
    use std::path::PathBuf;

    fn metadata(id: Uuid, last_prompt_at: u64) -> ThreadMetadata {
        ThreadMetadata {
            id,
            title: id.to_string(),
            working_folder: PathBuf::from("/project"),
            agent_id: "codex".into(),
            remote_session_id: None,
            created_at: 1,
            updated_at: 1,
            last_prompt_at,
            status: ThreadStatus::SessionReady,
            failure: None,
            interrupted: false,
        }
    }

    #[test]
    fn sorts_by_latest_prompt_instead_of_general_updates() {
        let older = Uuid::from_u128(1);
        let newer = Uuid::from_u128(2);
        let mut list = ThreadList::default();
        let mut older_metadata = metadata(older, 10);
        older_metadata.updated_at = 999;
        list.entries.insert(older, older_metadata);
        list.entries.insert(newer, metadata(newer, 20));

        assert_eq!(
            list.sorted_entries()
                .into_iter()
                .map(|entry| entry.id)
                .collect::<Vec<_>>(),
            vec![newer, older]
        );
    }
}
