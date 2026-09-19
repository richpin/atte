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
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        entries
    }

    pub fn publish(&mut self, metadata: ThreadMetadata) {
        self.entries.insert(metadata.id, metadata);
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
