use super::ManagementError;
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    io::{Read, Write},
    path::Path,
    pin::Pin,
    time::Duration,
};

pub type DownloadFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), ManagementError>> + Send + 'a>>;
/// External artifact transport. Verification and extraction remain in the installer.
pub trait Downloader: Send + Sync {
    fn download<'a>(
        &'a self,
        url: &'a str,
        destination: &'a Path,
        progress: &'a (dyn Fn(&str) + Send + Sync),
    ) -> DownloadFuture<'a>;
}
pub struct HttpDownloader;
const MAX_DOWNLOAD: u64 = 1024 * 1024 * 1024;
impl Downloader for HttpDownloader {
    fn download<'a>(
        &'a self,
        url: &'a str,
        destination: &'a Path,
        progress: &'a (dyn Fn(&str) + Send + Sync),
    ) -> DownloadFuture<'a> {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .https_only(true)
                .timeout(Duration::from_secs(300))
                .build()
                .map_err(|_| ManagementError::Network)?;
            let mut response = client
                .get(url)
                .send()
                .await
                .map_err(|_| ManagementError::Network)?
                .error_for_status()
                .map_err(|_| ManagementError::Network)?;
            let mut file =
                std::fs::File::create(destination).map_err(|_| ManagementError::Install)?;
            let mut size = 0;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| ManagementError::Network)?
            {
                size += chunk.len() as u64;
                if size > MAX_DOWNLOAD {
                    return Err(ManagementError::Install);
                }
                file.write_all(&chunk)
                    .map_err(|_| ManagementError::Install)?;
                progress(&format!("다운로드 {} MB", size / (1024 * 1024)));
            }
            Ok(())
        })
    }
}

pub(crate) fn verify(path: &Path, expected: Option<&str>) -> Result<(), ManagementError> {
    let mut file = std::fs::File::open(path).map_err(|_| ManagementError::Install)?;
    if file.metadata().map_err(|_| ManagementError::Install)?.len() > MAX_DOWNLOAD {
        return Err(ManagementError::Install);
    }
    if let Some(expected) = expected {
        let mut hash = Sha256::new();
        let mut bytes = [0; 65536];
        loop {
            let read = file
                .read(&mut bytes)
                .map_err(|_| ManagementError::Install)?;
            if read == 0 {
                break;
            }
            hash.update(&bytes[..read]);
        }
        if !expected.eq_ignore_ascii_case(&format!("{:x}", hash.finalize())) {
            return Err(ManagementError::Integrity);
        }
    }
    Ok(())
}
