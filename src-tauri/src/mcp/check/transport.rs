//! Keep an awaitable close boundary even when initialization is cancelled.
use rmcp::{
    service::{RoleClient, RxJsonRpcMessage, TxJsonRpcMessage},
    transport::Transport,
};
use tokio::sync::oneshot;

#[derive(Debug, thiserror::Error)]
pub(super) enum Error<E: std::error::Error + 'static> {
    #[error("MCP transport failed")]
    Inner(#[source] E),
    #[error("Connection closed")]
    Closed,
}
pub(super) struct ClosingTransport<T: Transport<RoleClient> + 'static> {
    transport: Option<T>,
    closed: Option<oneshot::Sender<()>>,
}
impl<T: Transport<RoleClient> + 'static> ClosingTransport<T> {
    pub(super) fn new(transport: T) -> (Self, oneshot::Receiver<()>) {
        let (sender, receiver) = oneshot::channel();
        (
            Self {
                transport: Some(transport),
                closed: Some(sender),
            },
            receiver,
        )
    }
}
impl<T: Transport<RoleClient> + 'static> Transport<RoleClient> for ClosingTransport<T> {
    type Error = Error<T::Error>;
    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send + 'static {
        let future = self
            .transport
            .as_mut()
            .map(|transport| transport.send(item));
        async move { future.ok_or(Error::Closed)?.await.map_err(Error::Inner) }
    }
    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleClient>> {
        match self.transport.as_mut() {
            Some(transport) => transport.receive().await,
            None => None,
        }
    }
    async fn close(&mut self) -> Result<(), Self::Error> {
        let result = match self.transport.as_mut() {
            Some(transport) => transport.close().await.map_err(Error::Inner),
            None => Ok(()),
        };
        self.transport.take();
        if let Some(closed) = self.closed.take() {
            let _ = closed.send(());
        }
        result
    }
}
impl<T: Transport<RoleClient> + 'static> Drop for ClosingTransport<T> {
    fn drop(&mut self) {
        if let Some(mut transport) = self.transport.take() {
            let closed = self.closed.take();
            tokio::spawn(async move {
                let _ = transport.close().await;
                if let Some(closed) = closed {
                    let _ = closed.send(());
                }
            });
        }
    }
}
