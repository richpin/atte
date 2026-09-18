use super::{mpsc, ConversationMetadata, HashMap, Uuid};

#[derive(Default)]
pub(super) struct ConversationList {
    pub entries: HashMap<Uuid, ConversationMetadata>,
    subscribers: Vec<mpsc::UnboundedSender<Vec<ConversationMetadata>>>,
}

impl ConversationList {
    pub fn sorted_entries(&self) -> Vec<ConversationMetadata> {
        let mut entries: Vec<_> = self.entries.values().cloned().collect();
        entries.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        entries
    }

    pub fn publish(&mut self, metadata: ConversationMetadata) {
        self.entries.insert(metadata.id, metadata);
        let entries = self.sorted_entries();
        self.subscribers
            .retain(|subscriber| subscriber.send(entries.clone()).is_ok());
    }

    pub fn subscribe(&mut self) -> mpsc::UnboundedReceiver<Vec<ConversationMetadata>> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let _ = sender.send(self.sorted_entries());
        self.subscribers
            .retain(|subscriber| !subscriber.is_closed());
        self.subscribers.push(sender);
        receiver
    }
}
