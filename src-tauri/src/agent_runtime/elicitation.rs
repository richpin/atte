//! Request ownership and user-aware connection deadlines.
use crate::thread::RuntimeUpdates;
use agent_client_protocol::{schema::v1::RequestId, JsonRpcResponse, SentRequest};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;

#[derive(Clone)]
pub(super) struct Owner {
    pub updates: RuntimeUpdates,
    pub operation: Uuid,
}

pub(super) type Owners = Arc<Mutex<HashMap<RequestId, Owner>>>;

pub(super) struct Lease {
    owners: Owners,
    id: RequestId,
    owner: Owner,
}

impl Lease {
    pub fn new<T>(
        sent: &SentRequest<T>,
        owners: &Owners,
        updates: &RuntimeUpdates,
        operation: Uuid,
    ) -> Self {
        let owner = Owner {
            updates: updates.clone(),
            operation,
        };
        let id = sent.id().clone();
        if let Ok(mut all) = owners.lock() {
            all.insert(id.clone(), owner.clone());
        }
        Self {
            owners: owners.clone(),
            id,
            owner,
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut all) = self.owners.lock() {
            all.remove(&self.id);
        }
        self.owner.updates.request_finished(self.owner.operation);
    }
}

pub(super) async fn call<T: JsonRpcResponse>(
    sent: SentRequest<T>,
    owners: &Owners,
    updates: &RuntimeUpdates,
) -> Result<T, agent_client_protocol::Error> {
    let _lease = Lease::new(&sent, owners, updates, Uuid::new_v4());
    sent.block_task().await
}

/// Charge only time spent waiting on the agent, not time spent answering its forms.
pub(super) async fn timeout<F: Future>(
    future: F,
    waiting: impl Fn() -> bool,
) -> Result<F::Output, ()> {
    tokio::pin!(future);
    let mut remaining = Duration::from_secs(30);
    loop {
        let paused = waiting();
        let started = tokio::time::Instant::now();
        tokio::select! {
            biased;
            result = &mut future => return Ok(result),
            _ = tokio::time::sleep(Duration::from_millis(25).min(remaining)) => {
                if !paused && !waiting() {
                    remaining = remaining.saturating_sub(started.elapsed());
                    if remaining.is_zero() { return Err(()); }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn user_input_can_take_longer_than_the_connection_deadline() {
        let started = tokio::time::Instant::now();
        let result = timeout(
            async {
                tokio::time::sleep(Duration::from_secs(40)).await;
                7
            },
            || true,
        )
        .await;
        assert_eq!(result, Ok(7));
        assert!(started.elapsed() > Duration::from_secs(30));
    }

    #[tokio::test(start_paused = true)]
    async fn unanswered_agent_requests_still_time_out() {
        let result = timeout(std::future::pending::<()>(), || false).await;
        assert_eq!(result, Err(()));
    }
}
