//! Central resource ceilings for native DNS import and export.

/// Maximum UTF-8 bytes accepted by one import operation.
pub const MAX_IMPORT_BYTES: usize = 16 * 1024 * 1024;
/// Maximum physical lines inspected by one import operation.
pub const MAX_IMPORT_LINES: usize = 200_000;
/// Maximum parsed records retained by one import operation.
pub const MAX_IMPORT_RECORDS: usize = 100_000;
/// Maximum UTF-8 bytes in one physical import line.
pub const MAX_IMPORT_LINE_BYTES: usize = 64 * 1024;
/// Maximum CSV fields parsed from one row.
pub const MAX_IMPORT_FIELDS: usize = 32;
/// Maximum UTF-8 bytes retained in one imported field.
pub const MAX_IMPORT_FIELD_BYTES: usize = 32 * 1024;
/// Maximum aggregate UTF-8 bytes retained across imported record fields.
pub const MAX_IMPORT_RETAINED_BYTES: usize = 16 * 1024 * 1024;

/// Maximum records accepted by a native formatter invocation.
pub const MAX_EXPORT_RECORDS: usize = 10_000;
/// Maximum UTF-8 bytes accepted in one exported record field.
pub const MAX_EXPORT_FIELD_BYTES: usize = 64 * 1024;
/// Maximum aggregate UTF-8 bytes accepted across exported record fields.
pub const MAX_EXPORT_INPUT_BYTES: usize = 16 * 1024 * 1024;
/// Maximum UTF-8 bytes produced by one native formatter invocation.
pub const MAX_EXPORT_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
