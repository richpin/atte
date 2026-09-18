use super::{mpsc, ConversationSummary, HashMap, Uuid};

#[derive(Default)]
pub(super) struct ConversationList {
    pub entries: HashMap<Uuid, ConversationSummary>,
    subscribers: Vec<mpsc::UnboundedSender<Vec<ConversationSummary>>>,
}

impl ConversationList {
    pub fn snapshot(&self) -> Vec<ConversationSummary> {
        let mut entries: Vec<_> = self.entries.values().cloned().collect();
        entries.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        entries
    }

    pub fn publish(&mut self, summary: ConversationSummary) {
        self.entries.insert(summary.id, summary);
        let snapshot = self.snapshot();
        self.subscribers
            .retain(|subscriber| subscriber.send(snapshot.clone()).is_ok());
    }

    pub fn subscribe(&mut self) -> mpsc::UnboundedReceiver<Vec<ConversationSummary>> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let _ = sender.send(self.snapshot());
        self.subscribers
            .retain(|subscriber| !subscriber.is_closed());
        self.subscribers.push(sender);
        receiver
    }
}
