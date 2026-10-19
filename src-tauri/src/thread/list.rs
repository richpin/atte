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
                .unwrap_or_else(|| b.created_at.saturating_mul(1_000))
                .cmp(
                    &a.last_prompt_at
                        .unwrap_or_else(|| a.created_at.saturating_mul(1_000)),
                )
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
            worktree: None,
            agent_id: "codex".into(),
            session_id: None,
            created_at: 1,
            updated_at: 1,
            last_prompt_at: Some(last_prompt_at),
            status: ThreadStatus::SessionReady,
            failure: None,
            completed_turn_id: None,
            interrupted: false,
        }
    }

    #[test]
    fn sorts_unprompted_threads_by_creation_time_without_pinning_them() {
        let mut list = ThreadList::default();
        for (id, created_at, last_prompt_at) in [
            (1, 3, None),
            (2, 1, None),
            (3, 1, Some(2_500)),
            (4, 1, Some(3_000)),
        ] {
            let id = Uuid::from_u128(id);
            let mut entry = metadata(id, 0);
            entry.created_at = created_at;
            entry.updated_at = 999;
            entry.last_prompt_at = last_prompt_at;
            list.entries.insert(id, entry);
        }
        assert_eq!(
            list.sorted_entries()
                .iter()
                .map(|entry| entry.id.as_u128())
                .collect::<Vec<_>>(),
            [1, 4, 3, 2]
        );
        list.entries
            .get_mut(&Uuid::from_u128(3))
            .unwrap()
            .last_prompt_at = Some(4_000);
        assert_eq!(list.sorted_entries()[0].id, Uuid::from_u128(3));
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
