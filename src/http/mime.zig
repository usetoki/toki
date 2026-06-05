//! ext → MIME type. comptime static map, alloc-free lookup. charset baked into text types.

const std = @import("std");

pub const default_type = "application/octet-stream";

const table = std.StaticStringMap([]const u8).initComptime(.{
    // text & markup
    .{ "html", "text/html; charset=utf-8" },
    .{ "htm", "text/html; charset=utf-8" },
    .{ "shtml", "text/html; charset=utf-8" },
    .{ "css", "text/css; charset=utf-8" },
    .{ "xml", "application/xml; charset=utf-8" },
    .{ "mml", "text/mathml" },
    .{ "txt", "text/plain; charset=utf-8" },
    .{ "md", "text/markdown; charset=utf-8" },
    .{ "markdown", "text/markdown; charset=utf-8" },
    .{ "csv", "text/csv; charset=utf-8" },
    .{ "ics", "text/calendar; charset=utf-8" },
    .{ "vcf", "text/vcard" },
    .{ "htc", "text/x-component" },
    // scripts & data
    .{ "js", "text/javascript; charset=utf-8" },
    .{ "mjs", "text/javascript; charset=utf-8" },
    .{ "cjs", "text/javascript; charset=utf-8" },
    .{ "json", "application/json; charset=utf-8" },
    .{ "map", "application/json; charset=utf-8" },
    .{ "jsonld", "application/ld+json; charset=utf-8" },
    .{ "webmanifest", "application/manifest+json; charset=utf-8" },
    .{ "wasm", "application/wasm" },
    .{ "xhtml", "application/xhtml+xml; charset=utf-8" },
    .{ "atom", "application/atom+xml" },
    .{ "rss", "application/rss+xml" },
    .{ "xsl", "application/xml; charset=utf-8" },
    // images
    .{ "gif", "image/gif" },
    .{ "jpeg", "image/jpeg" },
    .{ "jpg", "image/jpeg" },
    .{ "jpe", "image/jpeg" },
    .{ "png", "image/png" },
    .{ "apng", "image/apng" },
    .{ "avif", "image/avif" },
    .{ "webp", "image/webp" },
    .{ "svg", "image/svg+xml; charset=utf-8" },
    .{ "svgz", "image/svg+xml; charset=utf-8" },
    .{ "tif", "image/tiff" },
    .{ "tiff", "image/tiff" },
    .{ "bmp", "image/bmp" },
    .{ "ico", "image/x-icon" },
    .{ "heic", "image/heic" },
    .{ "heif", "image/heif" },
    .{ "jxl", "image/jxl" },
    .{ "jng", "image/x-jng" },
    .{ "wbmp", "image/vnd.wap.wbmp" },
    // fonts
    .{ "woff", "font/woff" },
    .{ "woff2", "font/woff2" },
    .{ "ttf", "font/ttf" },
    .{ "otf", "font/otf" },
    .{ "eot", "application/vnd.ms-fontobject" },
    // audio
    .{ "mid", "audio/midi" },
    .{ "midi", "audio/midi" },
    .{ "kar", "audio/midi" },
    .{ "mp3", "audio/mpeg" },
    .{ "ogg", "audio/ogg" },
    .{ "oga", "audio/ogg" },
    .{ "opus", "audio/opus" },
    .{ "wav", "audio/wav" },
    .{ "weba", "audio/webm" },
    .{ "aac", "audio/aac" },
    .{ "flac", "audio/flac" },
    .{ "m4a", "audio/mp4" },
    .{ "ra", "audio/x-realaudio" },
    // video
    .{ "mp4", "video/mp4" },
    .{ "m4v", "video/mp4" },
    .{ "mpeg", "video/mpeg" },
    .{ "mpg", "video/mpeg" },
    .{ "mov", "video/quicktime" },
    .{ "webm", "video/webm" },
    .{ "ogv", "video/ogg" },
    .{ "avi", "video/x-msvideo" },
    .{ "mkv", "video/x-matroska" },
    .{ "flv", "video/x-flv" },
    .{ "wmv", "video/x-ms-wmv" },
    .{ "asf", "video/x-ms-asf" },
    .{ "asx", "video/x-ms-asf" },
    .{ "m3u8", "application/vnd.apple.mpegurl" },
    .{ "ts", "video/mp2t" },
    .{ "3gp", "video/3gpp" },
    .{ "3gpp", "video/3gpp" },
    // documents
    .{ "pdf", "application/pdf" },
    .{ "rtf", "application/rtf" },
    .{ "doc", "application/msword" },
    .{ "xls", "application/vnd.ms-excel" },
    .{ "ppt", "application/vnd.ms-powerpoint" },
    .{ "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    .{ "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    .{ "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
    .{ "odt", "application/vnd.oasis.opendocument.text" },
    .{ "ods", "application/vnd.oasis.opendocument.spreadsheet" },
    .{ "odp", "application/vnd.oasis.opendocument.presentation" },
    .{ "odg", "application/vnd.oasis.opendocument.graphics" },
    .{ "ps", "application/postscript" },
    .{ "eps", "application/postscript" },
    .{ "ai", "application/postscript" },
    // archives
    .{ "zip", "application/zip" },
    .{ "gz", "application/gzip" },
    .{ "tar", "application/x-tar" },
    .{ "7z", "application/x-7z-compressed" },
    .{ "rar", "application/x-rar-compressed" },
    .{ "bz2", "application/x-bzip2" },
    .{ "jar", "application/java-archive" },
    .{ "war", "application/java-archive" },
    .{ "ear", "application/java-archive" },
    .{ "swf", "application/x-shockwave-flash" },
    .{ "sit", "application/x-stuffit" },
    .{ "cab", "application/vnd.ms-cab-compressed" },
    .{ "xz", "application/x-xz" },
    .{ "lz", "application/x-lzip" },
    .{ "zst", "application/zstd" },
    // certificates & misc binary
    .{ "der", "application/x-x509-ca-cert" },
    .{ "pem", "application/x-x509-ca-cert" },
    .{ "crt", "application/x-x509-ca-cert" },
    .{ "rpm", "application/x-redhat-package-manager" },
    .{ "msi", "application/x-msdownload" },
    .{ "apk", "application/vnd.android.package-archive" },
    // office variants
    .{ "xlc", "application/vnd.ms-excel" },
    .{ "xlt", "application/vnd.ms-excel" },
    .{ "xla", "application/vnd.ms-excel" },
    .{ "xlw", "application/vnd.ms-excel" },
    .{ "pps", "application/vnd.ms-powerpoint" },
    .{ "pot", "application/vnd.ms-powerpoint" },
    .{ "dotx", "application/vnd.openxmlformats-officedocument.wordprocessingml.template" },
    .{ "xltx", "application/vnd.openxmlformats-officedocument.spreadsheetml.template" },
    .{ "potx", "application/vnd.openxmlformats-officedocument.presentationml.template" },
    // opendocument variants
    .{ "odc", "application/vnd.oasis.opendocument.chart" },
    .{ "odb", "application/vnd.oasis.opendocument.database" },
    .{ "odf", "application/vnd.oasis.opendocument.formula" },
    .{ "odi", "application/vnd.oasis.opendocument.image" },
    .{ "otg", "application/vnd.oasis.opendocument.graphics-template" },
    .{ "otp", "application/vnd.oasis.opendocument.presentation-template" },
    .{ "ots", "application/vnd.oasis.opendocument.spreadsheet-template" },
    .{ "ott", "application/vnd.oasis.opendocument.text-template" },
    .{ "odm", "application/vnd.oasis.opendocument.text-master" },
    // more images
    .{ "jp2", "image/jp2" },
    .{ "jpx", "image/jpx" },
    .{ "djvu", "image/vnd.djvu" },
    .{ "djv", "image/vnd.djvu" },
    .{ "psd", "image/vnd.adobe.photoshop" },
    .{ "xcf", "image/x-xcf" },
    .{ "cur", "image/x-icon" },
    // more audio/video
    .{ "ac3", "audio/ac3" },
    .{ "au", "audio/basic" },
    .{ "snd", "audio/basic" },
    .{ "aif", "audio/x-aiff" },
    .{ "aiff", "audio/x-aiff" },
    .{ "m3u", "audio/x-mpegurl" },
    .{ "ram", "audio/x-pn-realaudio" },
    .{ "mp2", "video/mpeg" },
    .{ "mpe", "video/mpeg" },
    .{ "vob", "video/mpeg" },
    .{ "qt", "video/quicktime" },
    .{ "rm", "application/vnd.rn-realmedia" },
    .{ "rmvb", "application/vnd.rn-realmedia-vbr" },
    // data / dev / docs
    .{ "ecma", "application/ecmascript" },
    .{ "nb", "application/mathematica" },
    .{ "sdp", "application/sdp" },
    .{ "smil", "application/smil+xml" },
    .{ "smi", "application/smil+xml" },
    .{ "xul", "application/vnd.mozilla.xul+xml" },
    .{ "pdb", "application/vnd.palm" },
    .{ "dcm", "application/dicom" },
    .{ "pgp", "application/pgp-encrypted" },
    .{ "gpg", "application/pgp-encrypted" },
    .{ "sig", "application/pgp-signature" },
    .{ "asc", "text/plain; charset=utf-8" },
    .{ "cdr", "application/vnd.corel-draw" },
    .{ "tex", "text/x-tex" },
    .{ "latex", "application/x-latex" },
    .{ "c", "text/x-csrc; charset=utf-8" },
    .{ "h", "text/x-chdr; charset=utf-8" },
    .{ "cpp", "text/x-c++src; charset=utf-8" },
    .{ "cc", "text/x-c++src; charset=utf-8" },
    .{ "cxx", "text/x-c++src; charset=utf-8" },
    .{ "hpp", "text/x-c++hdr; charset=utf-8" },
    .{ "java", "text/x-java-source; charset=utf-8" },
    .{ "py", "text/x-python; charset=utf-8" },
    .{ "rb", "text/x-ruby; charset=utf-8" },
    .{ "go", "text/x-go; charset=utf-8" },
    .{ "rs", "text/x-rust; charset=utf-8" },
    .{ "zig", "text/x-zig; charset=utf-8" },
    .{ "sh", "application/x-sh" },
    .{ "tcl", "application/x-tcl" },
    .{ "tk", "application/x-tcl" },
    .{ "yaml", "application/yaml; charset=utf-8" },
    .{ "yml", "application/yaml; charset=utf-8" },
    .{ "toml", "application/toml; charset=utf-8" },
});

/// MIME type for a path's extension, else octet-stream.
pub fn lookupPath(path: []const u8) []const u8 {
    const dot = std.mem.lastIndexOfScalar(u8, path, '.') orelse return default_type;
    return lookupExt(path[dot + 1 ..]);
}

/// MIME type for a bare extension (no dot), ASCII case-insensitive.
pub fn lookupExt(ext: []const u8) []const u8 {
    var lower: [16]u8 = undefined;
    // bail before the lowercase loop overruns the fixed buffer
    if (ext.len == 0 or ext.len > lower.len) return default_type;
    for (ext, 0..) |c, i| lower[i] = std.ascii.toLower(c);
    return table.get(lower[0..ext.len]) orelse default_type;
}

/// Whether a content type is worth compressing.
pub fn isCompressible(content_type: []const u8) bool {
    if (std.mem.startsWith(u8, content_type, "text/")) return true;
    if (std.mem.startsWith(u8, content_type, "image/svg")) return true;
    if (std.mem.startsWith(u8, content_type, "application/")) {
        const sub = content_type["application/".len..];
        return std.mem.startsWith(u8, sub, "json") or
            std.mem.startsWith(u8, sub, "javascript") or
            std.mem.startsWith(u8, sub, "xml") or
            std.mem.startsWith(u8, sub, "wasm") or
            std.mem.indexOf(u8, sub, "+json") != null or
            std.mem.indexOf(u8, sub, "+xml") != null;
    }
    return false;
}
