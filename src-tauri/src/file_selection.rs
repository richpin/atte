use std::{collections::HashMap, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::thread::{Attachment, ThreadError, UserInput};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileSelection {
    pub(crate) attachments: Vec<Attachment>,
    pub(crate) errors: Vec<FileSelectionError>,
}

#[derive(Debug, Serialize)]
pub(crate) struct FileSelectionError {
    pub(crate) name: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SubmittedInput {
    pub(crate) text: String,
    pub(crate) attachments: Vec<Uuid>,
}

struct SelectedFile {
    owner: String,
    attachment: Attachment,
}

#[derive(Default)]
pub(crate) struct SelectedFiles(Mutex<HashMap<Uuid, SelectedFile>>);

impl SelectedFiles {
    pub(crate) fn remember(
        &self,
        owner: &str,
        selection: &FileSelection,
    ) -> Result<(), ThreadError> {
        let mut selected = self.0.lock().map_err(|_| unavailable())?;
        selected.extend(selection.attachments.iter().cloned().map(|attachment| {
            (
                attachment.id,
                SelectedFile {
                    owner: owner.into(),
                    attachment,
                },
            )
        }));
        Ok(())
    }

    pub(crate) fn resolve(
        &self,
        owner: &str,
        submitted: &SubmittedInput,
    ) -> Result<UserInput, ThreadError> {
        let selected = self.0.lock().map_err(|_| unavailable())?;
        let attachments = submitted
            .attachments
            .iter()
            .map(|id| {
                selected
                    .get(id)
                    .filter(|selected| selected.owner == owner)
                    .map(|selected| selected.attachment.clone())
                    .ok_or_else(invalid_attachment)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(UserInput {
            body: submitted.text.clone(),
            attachments,
        })
    }

    pub(crate) fn forget(&self, owner: &str, ids: &[Uuid]) {
        let mut selected = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for id in ids {
            if selected
                .get(id)
                .is_some_and(|selected| selected.owner == owner)
            {
                selected.remove(id);
            }
        }
    }

    pub(crate) fn forget_owner(&self, owner: &str) {
        let mut selected = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        selected.retain(|_, selected| selected.owner != owner);
    }
}

pub(crate) fn prepare_file_selection(paths: impl IntoIterator<Item = PathBuf>) -> FileSelection {
    let mut result = FileSelection {
        attachments: Vec::new(),
        errors: Vec::new(),
    };
    for path in paths {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "선택한 파일".into());
        let prepared = std::fs::canonicalize(&path).ok().and_then(|canonical| {
            canonical
                .metadata()
                .ok()
                .filter(|metadata| metadata.is_file())
                .and_then(|_| tauri::Url::from_file_path(canonical).ok())
        });
        if let Some(uri) = prepared {
            result.attachments.push(Attachment {
                id: Uuid::new_v4(),
                name,
                uri: uri.to_string(),
            });
        } else {
            result.errors.push(FileSelectionError { name });
        }
    }
    result
}

fn invalid_attachment() -> ThreadError {
    ThreadError::InvalidMessage("첨부 파일을 다시 선택해주세요.".into())
}

fn unavailable() -> ThreadError {
    ThreadError::Unavailable("선택한 파일을 사용할 수 없습니다.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepares_a_regular_file_with_its_canonical_uri() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("a file.png");
        std::fs::write(&file, "image-shaped bytes").unwrap();

        let selection = prepare_file_selection([file]);

        assert_eq!(
            (
                selection.attachments[0].name.as_str(),
                selection.attachments[0].uri.ends_with("/a%20file.png"),
            ),
            ("a file.png", true)
        );
    }

    #[test]
    fn reports_a_directory_as_an_individual_error() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("folder");
        std::fs::create_dir(&directory).unwrap();

        let selection = prepare_file_selection([directory]);

        assert_eq!(selection.errors[0].name, "folder");
    }

    #[test]
    fn reports_a_missing_file_as_an_individual_error() {
        let root = tempfile::tempdir().unwrap();

        let selection = prepare_file_selection([root.path().join("missing.txt")]);

        assert_eq!(selection.errors[0].name, "missing.txt");
    }

    #[test]
    fn resolves_only_attachments_issued_by_file_selection() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("notes.txt");
        std::fs::write(&file, "notes").unwrap();
        let selection = prepare_file_selection([file]);
        let selected = SelectedFiles::default();
        selected.remember("main", &selection).unwrap();
        let submitted = SubmittedInput {
            text: "read this".into(),
            attachments: vec![selection.attachments[0].id],
        };

        let resolved = selected.resolve("main", &submitted).unwrap();

        assert_eq!(resolved.attachments, selection.attachments);
    }

    #[test]
    fn rejects_an_attachment_id_that_was_not_issued() {
        let selected = SelectedFiles::default();
        let submitted = SubmittedInput {
            text: String::new(),
            attachments: vec![Uuid::new_v4()],
        };

        let result = selected.resolve("main", &submitted);

        assert!(matches!(result, Err(ThreadError::InvalidMessage(_))));
    }

    #[test]
    fn resolves_remembered_metadata_after_the_source_is_deleted() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("ephemeral.txt");
        std::fs::write(&file, "temporary").unwrap();
        let selection = prepare_file_selection([file.clone()]);
        let selected = SelectedFiles::default();
        selected.remember("main", &selection).unwrap();
        std::fs::remove_file(file).unwrap();
        let submitted = SubmittedInput {
            text: String::new(),
            attachments: vec![selection.attachments[0].id],
        };

        let resolved = selected.resolve("main", &submitted).unwrap();

        assert_eq!(resolved.attachments, selection.attachments);
    }

    #[test]
    fn releases_a_removed_selection_for_the_owning_window() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("notes.txt");
        std::fs::write(&file, "notes").unwrap();
        let selection = prepare_file_selection([file]);
        let selected = SelectedFiles::default();
        selected.remember("main", &selection).unwrap();

        selected.forget("main", &[selection.attachments[0].id]);

        let submitted = SubmittedInput {
            text: String::new(),
            attachments: vec![selection.attachments[0].id],
        };
        assert!(matches!(
            selected.resolve("main", &submitted),
            Err(ThreadError::InvalidMessage(_))
        ));
    }

    #[test]
    fn releases_abandoned_selections_when_the_owning_window_closes() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("notes.txt");
        std::fs::write(&file, "notes").unwrap();
        let selection = prepare_file_selection([file]);
        let selected = SelectedFiles::default();
        selected.remember("main", &selection).unwrap();

        selected.forget_owner("main");

        let submitted = SubmittedInput {
            text: String::new(),
            attachments: vec![selection.attachments[0].id],
        };
        assert!(matches!(
            selected.resolve("main", &submitted),
            Err(ThreadError::InvalidMessage(_))
        ));
    }
}
