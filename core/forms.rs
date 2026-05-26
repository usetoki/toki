//! Native request-body form parsing for the dynamic path. Runs only when
//! `parseForms` is enabled and the body has been fully buffered for a JS-handled
//! route; the fast-path never reaches here. `application/x-www-form-urlencoded`
//! and `multipart/form-data` are understood — any other type is `NotForm`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures_util::stream;

use crate::convert::{ErrorResponse, FormField, FormFile, ParsedForm};
use crate::server::FormConfig;

pub enum FormOutcome {
    Parsed(ParsedForm),
    /// Not a form type; the caller passes the raw body through unchanged.
    NotForm,
    /// Answer natively without calling JavaScript (`400` / `413` / `415` / `500`).
    /// Carried as a kind, not bytes, so the connection loop renders it with the
    /// response defaults (which this module never sees) before writing.
    Reject(ErrorResponse),
}

enum FormKind {
    UrlEncoded,
    Multipart(String),
}

/// Mixed into generated upload filenames so concurrent writes within the same
/// nanosecond cannot collide.
static UPLOAD_SEQ: AtomicU64 = AtomicU64::new(0);

/// Classify a `Content-Type`, ignoring trailing parameters except the multipart
/// `boundary`. Returns `None` for non-form types.
fn classify(content_type: &str) -> Option<FormKind> {
    let media_type = match content_type.split_once(';') {
        Some((media, _)) => media.trim(),
        None => content_type.trim(),
    };

    if media_type.eq_ignore_ascii_case("application/x-www-form-urlencoded") {
        return Some(FormKind::UrlEncoded);
    }
    if media_type.eq_ignore_ascii_case("multipart/form-data") {
        // Without a boundary the body is unparseable.
        let boundary = multer::parse_boundary(content_type).ok()?;
        return Some(FormKind::Multipart(boundary));
    }
    None
}

pub async fn parse(content_type: &str, body: &Bytes, config: &FormConfig) -> FormOutcome {
    match classify(content_type) {
        Some(FormKind::UrlEncoded) => parse_urlencoded(body),
        Some(FormKind::Multipart(boundary)) => parse_multipart(boundary, body, config).await,
        None => FormOutcome::NotForm,
    }
}

/// Decode a urlencoded body into fields. Decoding never fails: malformed escapes
/// pass through lossily, as browsers and most servers treat them.
fn parse_urlencoded(body: &Bytes) -> FormOutcome {
    let fields = form_urlencoded::parse(body)
        .map(|(name, value)| FormField {
            name: name.into_owned(),
            value: value.into_owned(),
        })
        .collect();
    FormOutcome::Parsed(ParsedForm {
        fields,
        files: Vec::new(),
    })
}

async fn parse_multipart(boundary: String, body: &Bytes, config: &FormConfig) -> FormOutcome {
    // Feed the buffered body to multer as a one-item stream; the clone is a
    // refcount bump, not a copy.
    let chunk: Result<Bytes, std::io::Error> = Ok(body.clone());
    let body_stream = stream::once(async move { chunk });
    let mut multipart = multer::Multipart::new(body_stream, boundary);

    let mut fields: Vec<FormField> = Vec::new();
    let mut files: Vec<FormFile> = Vec::new();

    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => return FormOutcome::Reject(ErrorResponse::BadRequest),
        };

        let field_name = field.name().unwrap_or("").to_owned();
        let filename = field.file_name().map(|name| name.to_owned());
        let content_type = field.content_type().map(|mime| mime.to_string());

        let Some(filename) = filename else {
            let value = match field.text().await {
                Ok(text) => text,
                Err(_) => return FormOutcome::Reject(ErrorResponse::BadRequest),
            };
            fields.push(FormField {
                name: field_name,
                value,
            });
            continue;
        };

        // Reject a disallowed extension with 415 before reading the body, so a bad
        // upload is cheap and the handler is never called.
        if !extension_allowed(&filename, config) {
            return FormOutcome::Reject(ErrorResponse::UnsupportedMediaType);
        }

        let data = match field.bytes().await {
            Ok(bytes) => bytes,
            Err(_) => return FormOutcome::Reject(ErrorResponse::BadRequest),
        };

        if let Some(max) = config.max_file_size {
            if data.len() > max {
                return FormOutcome::Reject(ErrorResponse::PayloadTooLarge);
            }
        }

        let size = data.len() as u32;
        match config.upload_dir.as_deref() {
            Some(dir) => {
                let path = match write_upload(dir, &filename, &data).await {
                    Ok(path) => path,
                    // A filesystem failure is server-side; surface a 500.
                    Err(_) => return FormOutcome::Reject(ErrorResponse::InternalError),
                };
                files.push(FormFile {
                    field: field_name,
                    filename: Some(filename),
                    content_type,
                    size,
                    data: None,
                    path: Some(path),
                });
            }
            None => files.push(FormFile {
                field: field_name,
                filename: Some(filename),
                content_type,
                size,
                data: Some(data.to_vec().into()),
                path: None,
            }),
        }
    }

    FormOutcome::Parsed(ParsedForm { fields, files })
}

/// Whether `filename`'s extension is permitted. A `None` allow-list permits
/// everything; otherwise a name with no extension is rejected.
fn extension_allowed(filename: &str, config: &FormConfig) -> bool {
    let Some(allowed) = config.allowed_file_extensions.as_ref() else {
        return true;
    };
    match filename.rsplit_once('.') {
        Some((_, ext)) if !ext.is_empty() => allowed.contains(&ext.to_ascii_lowercase()),
        _ => false,
    }
}

/// Write uploaded bytes to a uniquely named file inside `dir` and return its path.
///
/// The client `filename` never builds the path — only its sanitized extension is
/// kept. The stored name comes from a timestamp and a process-wide counter, so a
/// malicious name (`../../etc/passwd`, absolute paths, separators) cannot escape
/// `dir` or collide with a concurrent upload.
async fn write_upload(dir: &str, filename: &str, data: &[u8]) -> std::io::Result<String> {
    tokio::fs::create_dir_all(dir).await?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = UPLOAD_SEQ.fetch_add(1, Ordering::Relaxed);

    let mut name = format!("upload-{now}-{seq}");
    if let Some(ext) = safe_extension(filename) {
        name.push('.');
        name.push_str(&ext);
    }

    let path: PathBuf = Path::new(dir).join(name);
    tokio::fs::write(&path, data).await?;
    Ok(path.to_string_lossy().into_owned())
}

/// A filesystem-safe extension from a client filename, or `None`. Restricting to
/// ASCII alphanumerics keeps separators, dots, and other traversal-enabling
/// characters out of the generated name.
fn safe_extension(filename: &str) -> Option<String> {
    let (_, ext) = filename.rsplit_once('.')?;
    if ext.is_empty() || ext.len() > 16 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> FormConfig {
        FormConfig {
            max_file_size: None,
            allowed_file_extensions: None,
            upload_dir: None,
        }
    }

    fn multipart_body(boundary: &str, parts: &[&str]) -> Bytes {
        let mut body = String::new();
        for part in parts {
            body.push_str("--");
            body.push_str(boundary);
            body.push_str("\r\n");
            body.push_str(part);
            body.push_str("\r\n");
        }
        body.push_str("--");
        body.push_str(boundary);
        body.push_str("--\r\n");
        Bytes::from(body)
    }

    fn parsed(outcome: FormOutcome) -> ParsedForm {
        match outcome {
            FormOutcome::Parsed(form) => form,
            FormOutcome::NotForm => panic!("expected Parsed, got NotForm"),
            FormOutcome::Reject(_) => panic!("expected Parsed, got Reject"),
        }
    }

    fn unique_upload_dir() -> PathBuf {
        let seq = UPLOAD_SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("toki-forms-test-{nanos}-{seq}"))
    }

    #[test]
    fn classify_recognizes_urlencoded() {
        assert!(matches!(
            classify("application/x-www-form-urlencoded"),
            Some(FormKind::UrlEncoded)
        ));
        assert!(matches!(
            classify("APPLICATION/X-WWW-FORM-URLENCODED; charset=utf-8"),
            Some(FormKind::UrlEncoded)
        ));
    }

    #[test]
    fn classify_extracts_multipart_boundary() {
        match classify("multipart/form-data; boundary=abc123") {
            Some(FormKind::Multipart(boundary)) => assert_eq!(boundary, "abc123"),
            _ => panic!("expected multipart"),
        }
    }

    #[test]
    fn classify_multipart_without_boundary_is_none() {
        assert!(classify("multipart/form-data").is_none());
    }

    #[test]
    fn classify_other_types_is_none() {
        assert!(classify("application/json").is_none());
        assert!(classify("text/plain").is_none());
    }

    #[tokio::test]
    async fn non_form_content_type_is_not_form() {
        let outcome = parse("application/json", &Bytes::from_static(b"{}"), &config()).await;
        assert!(matches!(outcome, FormOutcome::NotForm));
    }

    #[tokio::test]
    async fn parses_urlencoded_fields() {
        let body = Bytes::from_static(b"name=alice&city=new+york&empty=");
        let form = parsed(parse("application/x-www-form-urlencoded", &body, &config()).await);
        assert!(form.files.is_empty());
        assert_eq!(form.fields.len(), 3);
        assert_eq!(
            (form.fields[0].name.as_str(), form.fields[0].value.as_str()),
            ("name", "alice")
        );
        assert_eq!(form.fields[1].value, "new york");
        assert_eq!(form.fields[2].value, "");
    }

    #[tokio::test]
    async fn urlencoded_decodes_percent_escapes() {
        let body = Bytes::from_static(b"path=%2Ftmp%2Ffile");
        let form = parsed(parse("application/x-www-form-urlencoded", &body, &config()).await);
        assert_eq!(form.fields[0].value, "/tmp/file");
    }

    #[tokio::test]
    async fn parses_multipart_text_fields() {
        let body = multipart_body(
            "X",
            &[
                "Content-Disposition: form-data; name=\"a\"\r\n\r\nfirst",
                "Content-Disposition: form-data; name=\"b\"\r\n\r\nsecond",
            ],
        );
        let form = parsed(parse("multipart/form-data; boundary=X", &body, &config()).await);
        assert!(form.files.is_empty());
        assert_eq!(form.fields.len(), 2);
        assert_eq!(
            (form.fields[0].name.as_str(), form.fields[0].value.as_str()),
            ("a", "first")
        );
        assert_eq!(
            (form.fields[1].name.as_str(), form.fields[1].value.as_str()),
            ("b", "second")
        );
    }

    #[tokio::test]
    async fn parses_multipart_file_inline() {
        let body = multipart_body(
            "X",
            &["Content-Disposition: form-data; name=\"upload\"; filename=\"hi.txt\"\r\nContent-Type: text/plain\r\n\r\nhello world"],
        );
        let form = parsed(parse("multipart/form-data; boundary=X", &body, &config()).await);
        assert_eq!(form.files.len(), 1);
        let file = &form.files[0];
        assert_eq!(file.field, "upload");
        assert_eq!(file.filename.as_deref(), Some("hi.txt"));
        assert_eq!(file.content_type.as_deref(), Some("text/plain"));
        assert_eq!(file.size, 11);
        assert_eq!(file.data.as_ref().unwrap().as_ref(), b"hello world");
        assert!(file.path.is_none());
    }

    #[tokio::test]
    async fn mixed_multipart_separates_fields_and_files() {
        let body = multipart_body(
            "B",
            &[
                "Content-Disposition: form-data; name=\"title\"\r\n\r\nReport",
                "Content-Disposition: form-data; name=\"doc\"; filename=\"r.txt\"\r\n\r\ndata",
            ],
        );
        let form = parsed(parse("multipart/form-data; boundary=B", &body, &config()).await);
        assert_eq!(form.fields.len(), 1);
        assert_eq!(form.files.len(), 1);
        assert_eq!(form.fields[0].name, "title");
        assert_eq!(form.files[0].field, "doc");
    }

    #[tokio::test]
    async fn malformed_multipart_is_rejected_400() {
        let body = Bytes::from_static(b"this is not multipart at all");
        let outcome = parse("multipart/form-data; boundary=X", &body, &config()).await;
        assert!(matches!(
            outcome,
            FormOutcome::Reject(ErrorResponse::BadRequest)
        ));
    }

    #[tokio::test]
    async fn missing_boundary_passes_through_as_not_form() {
        // No boundary parameter => classify returns None => NotForm.
        let body = Bytes::from_static(b"--X\r\n--X--\r\n");
        let outcome = parse("multipart/form-data", &body, &config()).await;
        assert!(matches!(outcome, FormOutcome::NotForm));
    }

    #[tokio::test]
    async fn oversized_file_is_rejected_413() {
        let mut cfg = config();
        cfg.max_file_size = Some(4);
        let body = multipart_body(
            "X",
            &["Content-Disposition: form-data; name=\"f\"; filename=\"big.txt\"\r\n\r\ntoo many bytes"],
        );
        let outcome = parse("multipart/form-data; boundary=X", &body, &cfg).await;
        assert!(matches!(
            outcome,
            FormOutcome::Reject(ErrorResponse::PayloadTooLarge)
        ));
    }

    #[tokio::test]
    async fn disallowed_extension_is_rejected_415() {
        let mut cfg = config();
        cfg.allowed_file_extensions = Some(vec!["png".to_owned()]);
        let body = multipart_body(
            "X",
            &["Content-Disposition: form-data; name=\"f\"; filename=\"evil.exe\"\r\n\r\nMZ"],
        );
        let outcome = parse("multipart/form-data; boundary=X", &body, &cfg).await;
        assert!(matches!(
            outcome,
            FormOutcome::Reject(ErrorResponse::UnsupportedMediaType)
        ));
    }

    #[tokio::test]
    async fn allowed_extension_is_accepted_case_insensitively() {
        let mut cfg = config();
        cfg.allowed_file_extensions = Some(vec!["png".to_owned()]);
        let body = multipart_body(
            "X",
            &["Content-Disposition: form-data; name=\"f\"; filename=\"photo.PNG\"\r\n\r\nbytes"],
        );
        let form = parsed(parse("multipart/form-data; boundary=X", &body, &cfg).await);
        assert_eq!(form.files.len(), 1);
    }

    #[tokio::test]
    async fn upload_dir_writes_file_and_reports_path() {
        let dir = unique_upload_dir();
        let mut cfg = config();
        cfg.upload_dir = Some(dir.to_string_lossy().into_owned());

        let body = multipart_body(
            "X",
            &["Content-Disposition: form-data; name=\"f\"; filename=\"note.txt\"\r\n\r\nsaved to disk"],
        );
        let form = parsed(parse("multipart/form-data; boundary=X", &body, &cfg).await);

        let file = &form.files[0];
        assert!(file.data.is_none());
        let path = file.path.as_ref().expect("path reported");
        let written = tokio::fs::read(path).await.expect("file exists");
        assert_eq!(written, b"saved to disk");
        // The stored name is generated, never the client filename.
        assert!(!path.contains("note.txt"));
        assert!(path.ends_with(".txt"));

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn upload_dir_ignores_traversal_in_client_filename() {
        let dir = unique_upload_dir();
        let mut cfg = config();
        cfg.upload_dir = Some(dir.to_string_lossy().into_owned());

        let body = multipart_body(
            "X",
            &["Content-Disposition: form-data; name=\"f\"; filename=\"../../etc/passwd\"\r\n\r\npwned"],
        );
        let form = parsed(parse("multipart/form-data; boundary=X", &body, &cfg).await);

        let path = form.files[0].path.as_ref().unwrap();
        let parent = Path::new(path).parent().unwrap();
        assert_eq!(parent, dir);
        assert!(!path.contains(".."));

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[test]
    fn extension_allow_list_none_permits_everything() {
        let cfg = config();
        assert!(extension_allowed("anything.xyz", &cfg));
        assert!(extension_allowed("noext", &cfg));
    }

    #[test]
    fn extension_allow_list_rejects_missing_extension() {
        let mut cfg = config();
        cfg.allowed_file_extensions = Some(vec!["txt".to_owned()]);
        assert!(!extension_allowed("README", &cfg));
        assert!(!extension_allowed("trailing.", &cfg));
        assert!(extension_allowed("file.txt", &cfg));
    }

    #[test]
    fn safe_extension_accepts_alphanumeric_only() {
        assert_eq!(safe_extension("a.txt"), Some("txt".to_owned()));
        assert_eq!(safe_extension("a.PNG"), Some("png".to_owned()));
        assert_eq!(safe_extension("archive.tar.gz"), Some("gz".to_owned()));
    }

    #[test]
    fn safe_extension_rejects_unsafe_or_absent() {
        assert_eq!(safe_extension("noext"), None);
        assert_eq!(safe_extension("a."), None);
        assert_eq!(safe_extension("a.ta/r"), None);
        assert_eq!(safe_extension("a.with-dash"), None);
        // Absurdly long extensions are dropped.
        assert_eq!(safe_extension("a.012345678901234567"), None);
    }
}
