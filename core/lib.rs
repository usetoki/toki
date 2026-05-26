//! Toki: a Tokio-powered HTTP/1.1 server exposed to Node.js and Bun as a Node-API addon.
//!
//! The public surface is [`server::listen`], which binds a socket and serves
//! requests on a dedicated Tokio runtime, and [`server::ServerHandle`], which
//! controls graceful shutdown. Routes registered as native are pre-rendered
//! into wire bytes and answered entirely in Rust; everything else crosses into
//! a JavaScript handler.
//!
//! Module layout:
//! - [`server`] — the napi surface, route table, dynamic router, and runtime
//!   bootstrap.
//! - [`http`] — the connection loop and HTTP/1.1 parsing.
//! - [`convert`] — the plain objects exchanged with JavaScript and response
//!   serialization for the dynamic path.
//! - [`forms`] — native request-body form parsing (urlencoded and
//!   multipart/form-data) used only on the dynamic path when enabled.
//! - [`meta`] — native dynamic routing (`:param`/`*` matching, 404/405
//!   decisions) and request-metadata parsing (query string, cookies, request
//!   id) for the dynamic path.
//! - [`static_files`] — native static-file serving for a configured URL prefix
//!   (traversal-safe path resolution, MIME/ETag/304, range support), checked
//!   after the exact route table and before the dynamic router. Never crosses
//!   into JavaScript.
//! - [`compress`] — `Accept-Encoding` negotiation and the gzip/brotli encoders,
//!   plus the one-time pre-compression of native routes. Used by static,
//!   dynamic, and native responses only when compression is enabled.

// `deny` (not `forbid`): napi-rs macros emit a local `#[allow(unsafe_code)]` for
// their generated N-API glue, which `forbid` would reject. `deny` still forbids
// unsafe in our hand-written code while letting the macro opt its own code out.
#![deny(
    unsafe_code,
    unused_imports,
    unused_variables,
    unused_mut,
    unused_must_use,
    unreachable_patterns,
    unreachable_code,
    unused_lifetimes,
    unused_qualifications
)]
// `dead_code` only outside tests: `#[napi]` exports and test-only helpers read as
// unused to the test harness, but the real cdylib build must stay free of it.
#![cfg_attr(not(test), deny(dead_code))]
#![warn(clippy::all)]

mod compress;
mod convert;
mod forms;
mod http;
mod meta;
mod server;
mod static_files;
