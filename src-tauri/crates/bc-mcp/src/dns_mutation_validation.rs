//! Fail-closed validation for Cloudflare DNS mutations.
//!
//! Record IDs are authorized only against a complete Cloudflare snapshot for
//! the requested zone. Caller-supplied owner/type/coexistence metadata is never
//! used as authority; optional legacy metadata is accepted only when it matches
//! the provider state exactly.

use std::collections::{HashMap, HashSet};

use bc_cloudflare_api::DNSRecord;
use serde_json::Value;

const MAX_DNS_LABEL_OCTETS: usize = 63;
const MAX_DNS_WIRE_NAME_OCTETS: usize = 255;
const MAX_TXT_CHUNK_OCTETS: usize = 255;
const MAX_RFC2181_TTL: u64 = (1_u64 << 31) - 1;

const SUPPORTED_RECORD_TYPES: &[&str] = &[
    "A",
    "AAAA",
    "CAA",
    "CERT",
    "CNAME",
    "DNAME",
    "DNSKEY",
    "DS",
    "HTTPS",
    "LOC",
    "MX",
    "NAPTR",
    "NS",
    "OPENPGPKEY",
    "PTR",
    "SMIMEA",
    "SOA",
    "SPF",
    "SRV",
    "SSHFP",
    "SVCB",
    "TLSA",
    "TXT",
    "URI",
];

#[derive(Debug, Clone)]
struct AuthoritativeRecord {
    id: String,
    owner: String,
    record_type: String,
}

#[derive(Debug, Clone)]
pub(crate) struct AuthoritativeDnsZone {
    zone_id: String,
    name: String,
    records: Vec<AuthoritativeRecord>,
}

#[derive(Debug)]
struct ValidatedRecord {
    owner: String,
    record_type: String,
}

#[derive(Debug)]
struct DeleteRequest {
    id: String,
    claimed_name: Option<String>,
    claimed_type: Option<String>,
}

/// Convert a provider lookup into the only state accepted by mutation
/// validators. Any lookup error or inconsistent provider metadata denies the
/// mutation rather than falling back to caller claims.
pub(crate) fn authoritative_zone_from_lookup(
    requested_zone_id: &str,
    lookup: Result<Vec<DNSRecord>, String>,
) -> Result<AuthoritativeDnsZone, String> {
    if requested_zone_id.is_empty() {
        return Err("Authoritative DNS lookup requires a non-empty zone ID.".to_string());
    }
    let records = lookup.map_err(|error| {
        format!("Authoritative DNS lookup failed closed for zone '{requested_zone_id}': {error}")
    })?;
    if records.is_empty() {
        return Err(format!(
            "Authoritative DNS lookup failed closed for zone '{requested_zone_id}': no records were returned, so the zone name and record state cannot be established."
        ));
    }

    let mut zone_name: Option<String> = None;
    let mut ids = HashSet::with_capacity(records.len());
    let mut authoritative = Vec::with_capacity(records.len());

    for (index, record) in records.into_iter().enumerate() {
        if record.zone_id != requested_zone_id {
            return Err(format!(
                "Authoritative DNS lookup failed closed: record at index {index} belongs to zone '{}' instead of requested zone '{requested_zone_id}'.",
                record.zone_id
            ));
        }

        let record_zone_name = canonical_domain_name(&record.zone_name, "Provider DNS zone name")
            .map_err(|error| {
            format!("Authoritative DNS lookup failed closed for record at index {index}: {error}")
        })?;
        if record_zone_name.is_empty() {
            return Err(format!(
                "Authoritative DNS lookup failed closed: record at index {index} has the root as its zone name."
            ));
        }
        match zone_name.as_deref() {
            Some(expected) if expected != record_zone_name => {
                return Err(format!(
                    "Authoritative DNS lookup failed closed: provider records disagree on zone name ('{expected}' versus '{record_zone_name}')."
                ));
            }
            None => zone_name = Some(record_zone_name.clone()),
            _ => {}
        }

        let id = record.id.filter(|id| !id.is_empty()).ok_or_else(|| {
            format!(
                "Authoritative DNS lookup failed closed: record at index {index} has no stable record ID."
            )
        })?;
        if !ids.insert(id.clone()) {
            return Err(format!(
                "Authoritative DNS lookup failed closed: record ID '{id}' is duplicated."
            ));
        }

        let owner = canonical_owner(&record.name, &record_zone_name).map_err(|error| {
            format!("Authoritative DNS lookup failed closed for record ID '{id}': {error}")
        })?;
        let record_type = normalized_record_type(&record.r#type).map_err(|error| {
            format!("Authoritative DNS lookup failed closed for record ID '{id}': {error}")
        })?;
        authoritative.push(AuthoritativeRecord {
            id,
            owner,
            record_type,
        });
    }
    validate_dname_hierarchy(
        authoritative
            .iter()
            .map(|record| (record.owner.as_str(), record.record_type.as_str())),
    )
    .map_err(|error| format!("Authoritative DNS lookup failed closed: {error}"))?;

    Ok(AuthoritativeDnsZone {
        zone_id: requested_zone_id.to_string(),
        name: zone_name.expect("non-empty provider record list establishes a zone name"),
        records: authoritative,
    })
}

pub(crate) fn validate_create(args: &Value, zone: &AuthoritativeDnsZone) -> Result<(), String> {
    validate_optional_zone_claim(args, zone)?;
    let record = validate_record(required_object(args, "record")?, &zone.name)?;
    let mut types = zone.record_types_at_owner(&record.owner, None);
    types.push(record.record_type.clone());
    validate_coexistence(&record.owner, &types, &zone.name)?;
    validate_dname_hierarchy(
        zone.records
            .iter()
            .map(|record| (record.owner.as_str(), record.record_type.as_str()))
            .chain(std::iter::once((
                record.owner.as_str(),
                record.record_type.as_str(),
            ))),
    )
}

pub(crate) fn validate_update(args: &Value, zone: &AuthoritativeDnsZone) -> Result<(), String> {
    validate_optional_zone_claim(args, zone)?;
    let record_id = required_nonempty_string(args, "record_id")?;
    let current = zone.record_by_id(record_id)?;

    // Protect the provider record before looking at any optional caller claim.
    reject_apex_authority_mutation(&current.owner, &current.record_type, &zone.name)?;
    validate_optional_owner_claim(args, "current_record_name", current, zone)?;
    validate_optional_type_claim(args, "current_record_type", current)?;

    let replacement = validate_record(required_object(args, "record")?, &zone.name)?;
    let mut types = zone.record_types_at_owner(&replacement.owner, Some(record_id));
    types.push(replacement.record_type.clone());
    validate_coexistence(&replacement.owner, &types, &zone.name)?;
    validate_dname_hierarchy(
        zone.records
            .iter()
            .filter(|record| record.id != record_id)
            .map(|record| (record.owner.as_str(), record.record_type.as_str()))
            .chain(std::iter::once((
                replacement.owner.as_str(),
                replacement.record_type.as_str(),
            ))),
    )
}

pub(crate) fn validate_delete(args: &Value, zone: &AuthoritativeDnsZone) -> Result<(), String> {
    validate_optional_zone_claim(args, zone)?;
    let record_id = required_nonempty_string(args, "record_id")?;
    let current = zone.record_by_id(record_id)?;

    // Apex authority protection is based exclusively on provider state.
    reject_apex_authority_mutation(&current.owner, &current.record_type, &zone.name)?;
    validate_optional_owner_claim(args, "record_name", current, zone)?;
    validate_optional_type_claim(args, "record_type", current)
}

pub(crate) fn validate_bulk_create(
    args: &Value,
    zone: &AuthoritativeDnsZone,
) -> Result<(), String> {
    validate_optional_zone_claim(args, zone)?;
    let records = required_array(args, "records")?;
    if records.is_empty() {
        return Err("DNS bulk mutation field 'records' must not be empty.".to_string());
    }

    let mut additions = Vec::with_capacity(records.len());
    for (index, value) in records.iter().enumerate() {
        let record = validate_record(value, &zone.name)
            .map_err(|error| format!("DNS bulk record at index {index}: {error}"))?;
        additions.push(record);
    }

    let mut additions_by_owner: HashMap<String, Vec<String>> = HashMap::new();
    for record in &additions {
        additions_by_owner
            .entry(record.owner.clone())
            .or_default()
            .push(record.record_type.clone());
    }

    for (owner, new_types) in additions_by_owner {
        let mut types = zone.record_types_at_owner(&owner, None);
        types.extend(new_types);
        validate_coexistence(&owner, &types, &zone.name)?;
    }
    validate_dname_hierarchy(
        zone.records
            .iter()
            .map(|record| (record.owner.as_str(), record.record_type.as_str()))
            .chain(
                additions
                    .iter()
                    .map(|record| (record.owner.as_str(), record.record_type.as_str())),
            ),
    )
}

pub(crate) fn validated_bulk_delete_ids(
    args: &Value,
    zone: &AuthoritativeDnsZone,
) -> Result<Vec<String>, String> {
    validate_optional_zone_claim(args, zone)?;
    let requests = requested_bulk_deletes(args)?;
    let mut seen = HashSet::with_capacity(requests.len());
    let mut ids = Vec::with_capacity(requests.len());

    for (index, request) in requests.into_iter().enumerate() {
        if !seen.insert(request.id.clone()) {
            return Err(format!(
                "DNS bulk delete entry at index {index} duplicates record ID '{}'.",
                request.id
            ));
        }
        let current = zone
            .record_by_id(&request.id)
            .map_err(|error| format!("DNS bulk delete entry at index {index}: {error}"))?;
        reject_apex_authority_mutation(&current.owner, &current.record_type, &zone.name)
            .map_err(|error| format!("DNS bulk delete entry at index {index}: {error}"))?;
        validate_claimed_owner(request.claimed_name.as_deref(), current, zone)
            .map_err(|error| format!("DNS bulk delete entry at index {index}: {error}"))?;
        validate_claimed_type(request.claimed_type.as_deref(), current)
            .map_err(|error| format!("DNS bulk delete entry at index {index}: {error}"))?;
        ids.push(request.id);
    }
    Ok(ids)
}

impl AuthoritativeDnsZone {
    fn record_by_id(&self, record_id: &str) -> Result<&AuthoritativeRecord, String> {
        self.records
            .iter()
            .find(|record| record.id == record_id)
            .ok_or_else(|| {
                format!(
                    "Authoritative DNS lookup did not find record ID '{record_id}' in zone '{}'; mutation denied.",
                    self.zone_id
                )
            })
    }

    fn record_types_at_owner(&self, owner: &str, exclude_id: Option<&str>) -> Vec<String> {
        self.records
            .iter()
            .filter(|record| {
                record.owner == owner && exclude_id.is_none_or(|id| record.id.as_str() != id)
            })
            .map(|record| record.record_type.clone())
            .collect()
    }
}

fn requested_bulk_deletes(args: &Value) -> Result<Vec<DeleteRequest>, String> {
    match (args.get("record_ids"), args.get("records")) {
        (Some(_), Some(_)) => Err(
            "DNS bulk delete must provide exactly one of 'record_ids' or legacy 'records'."
                .to_string(),
        ),
        (Some(value), None) => {
            let values = value.as_array().ok_or_else(|| {
                "DNS bulk mutation field 'record_ids' must be an array.".to_string()
            })?;
            if values.is_empty() {
                return Err(
                    "DNS bulk mutation field 'record_ids' must not be empty.".to_string()
                );
            }
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    let id = value.as_str().filter(|id| !id.is_empty()).ok_or_else(|| {
                        format!(
                            "DNS bulk delete record ID at index {index} must be a non-empty string."
                        )
                    })?;
                    Ok(DeleteRequest {
                        id: id.to_string(),
                        claimed_name: None,
                        claimed_type: None,
                    })
                })
                .collect()
        }
        (None, Some(value)) => {
            let values = value.as_array().ok_or_else(|| {
                "DNS bulk mutation field 'records' must be an array.".to_string()
            })?;
            if values.is_empty() {
                return Err("DNS bulk mutation field 'records' must not be empty.".to_string());
            }
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    let record = value.as_object().ok_or_else(|| {
                        format!("DNS bulk delete entry at index {index} must be an object.")
                    })?;
                    let id = required_object_string(record, "record_id")
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| {
                            format!(
                                "DNS bulk delete entry at index {index}: field 'record_id' must be a non-empty string."
                            )
                        })?;
                    Ok(DeleteRequest {
                        id: id.to_string(),
                        claimed_name: optional_object_string(record, "name")?
                            .map(str::to_string),
                        claimed_type: optional_object_string(record, "type")?
                            .map(str::to_string),
                    })
                })
                .collect()
        }
        (None, None) => Err(
            "DNS bulk delete requires the 'record_ids' array; authoritative owner/type metadata is fetched from Cloudflare."
                .to_string(),
        ),
    }
}

fn validate_optional_zone_claim(args: &Value, zone: &AuthoritativeDnsZone) -> Result<(), String> {
    let Some(claimed) = optional_string(args, "zone_name")? else {
        return Ok(());
    };
    let claimed = canonical_domain_name(claimed, "Claimed DNS zone name")?;
    if claimed != zone.name {
        return Err(format!(
            "Caller-supplied zone name '{claimed}' does not match authoritative zone name '{}'; mutation denied.",
            zone.name
        ));
    }
    Ok(())
}

fn validate_optional_owner_claim(
    args: &Value,
    field: &str,
    record: &AuthoritativeRecord,
    zone: &AuthoritativeDnsZone,
) -> Result<(), String> {
    validate_claimed_owner(optional_string(args, field)?, record, zone)
}

fn validate_claimed_owner(
    claimed: Option<&str>,
    record: &AuthoritativeRecord,
    zone: &AuthoritativeDnsZone,
) -> Result<(), String> {
    let Some(claimed) = claimed else {
        return Ok(());
    };
    let claimed = canonical_owner(claimed, &zone.name)?;
    if claimed != record.owner {
        return Err(format!(
            "Caller-supplied record owner '{claimed}' does not match authoritative owner '{}'; mutation denied.",
            record.owner
        ));
    }
    Ok(())
}

fn validate_optional_type_claim(
    args: &Value,
    field: &str,
    record: &AuthoritativeRecord,
) -> Result<(), String> {
    validate_claimed_type(optional_string(args, field)?, record)
}

fn validate_claimed_type(
    claimed: Option<&str>,
    record: &AuthoritativeRecord,
) -> Result<(), String> {
    let Some(claimed) = claimed else {
        return Ok(());
    };
    let claimed = normalized_record_type(claimed)?;
    if claimed != record.record_type {
        return Err(format!(
            "Caller-supplied record type '{claimed}' does not match authoritative type '{}'; mutation denied.",
            record.record_type
        ));
    }
    Ok(())
}

fn validate_record(record: &Value, zone: &str) -> Result<ValidatedRecord, String> {
    let object = record
        .as_object()
        .ok_or_else(|| "DNS mutation field 'record' must be an object.".to_string())?;
    let owner = canonical_owner(required_object_string_value(object, "name")?, zone)?;
    let record_type = normalized_record_type(required_object_string_value(object, "type")?)?;
    reject_apex_authority_mutation(&owner, &record_type, zone)?;

    let content = required_object_string_value(object, "content")?;
    if content.is_empty() {
        return Err("DNS record field 'content' must not be empty.".to_string());
    }

    if let Some(ttl) = object.get("ttl") {
        let ttl = ttl
            .as_u64()
            .ok_or_else(|| "DNS record TTL must be a non-negative integer.".to_string())?;
        if ttl > MAX_RFC2181_TTL {
            return Err(format!(
                "DNS record TTL exceeds the RFC 2181 maximum of {MAX_RFC2181_TTL}."
            ));
        }
    }

    if record_type == "TXT" {
        validate_txt_chunks(content)?;
    }
    if record_type == "CNAME" || record_type == "DNAME" {
        let target = canonical_domain_name(content, "DNS alias target")?;
        if target.is_empty() {
            return Err("DNS alias target must not be the root name.".to_string());
        }
        if record_type == "DNAME" {
            validate_dname_owner_and_target(&owner, &target)?;
        }
    }

    Ok(ValidatedRecord { owner, record_type })
}

fn required_nonempty_string<'a>(args: &'a Value, field: &str) -> Result<&'a str, String> {
    required_string(args, field).and_then(|value| {
        if value.is_empty() {
            Err(format!("DNS mutation field '{field}' must not be empty."))
        } else {
            Ok(value)
        }
    })
}

fn required_string<'a>(args: &'a Value, field: &str) -> Result<&'a str, String> {
    args.get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("DNS mutation field '{field}' must be a string."))
}

fn optional_string<'a>(args: &'a Value, field: &str) -> Result<Option<&'a str>, String> {
    args.get(field)
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| format!("DNS mutation field '{field}' must be a string."))
        })
        .transpose()
}

fn required_object<'a>(args: &'a Value, field: &str) -> Result<&'a Value, String> {
    args.get(field)
        .filter(|value| value.is_object())
        .ok_or_else(|| format!("DNS mutation field '{field}' must be an object."))
}

fn required_array<'a>(args: &'a Value, field: &str) -> Result<&'a [Value], String> {
    args.get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("DNS mutation field '{field}' must be an array."))
}

fn required_object_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Option<&'a str> {
    object.get(field).and_then(Value::as_str)
}

fn required_object_string_value<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Result<&'a str, String> {
    required_object_string(object, field)
        .ok_or_else(|| format!("field '{field}' must be a string."))
}

fn optional_object_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<&'a str>, String> {
    object
        .get(field)
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| format!("field '{field}' must be a string."))
        })
        .transpose()
}

fn normalized_record_type(value: &str) -> Result<String, String> {
    if value.is_empty() || value.trim() != value {
        return Err("DNS record type must be a non-empty unpadded string.".to_string());
    }
    let normalized = value.to_ascii_uppercase();
    if !SUPPORTED_RECORD_TYPES.contains(&normalized.as_str()) {
        return Err(format!(
            "DNS record type '{value}' is not classified for safe mutation."
        ));
    }
    Ok(normalized)
}

fn canonical_owner(value: &str, zone: &str) -> Result<String, String> {
    if value == "@" {
        return Ok(zone.to_string());
    }
    let owner = canonical_domain_name(value, "DNS record owner")?;
    if owner != zone && !owner.ends_with(&format!(".{zone}")) {
        return Err("DNS record owner must be the zone apex or a name below it.".to_string());
    }
    Ok(owner)
}

fn canonical_domain_name(value: &str, field: &str) -> Result<String, String> {
    if value.is_empty() {
        return Err(format!("{field} must not be empty."));
    }
    if !value.is_ascii() {
        return Err(format!(
            "{field} must use an ASCII DNS wire spelling (use A-labels for internationalized names)."
        ));
    }
    if value.chars().any(|character| {
        character.is_ascii_control() || character.is_ascii_whitespace() || character == '\\'
    }) {
        return Err(format!(
            "{field} contains an unsafe or ambiguous character."
        ));
    }
    if value == "." {
        return Ok(String::new());
    }

    let without_root = value.strip_suffix('.').unwrap_or(value);
    if without_root.is_empty() {
        return Err(format!("{field} has an invalid trailing root label."));
    }

    let mut wire_octets = 1_usize;
    for label in without_root.split('.') {
        if label.is_empty() {
            return Err(format!("{field} contains an empty interior label."));
        }
        let label_octets = label.len();
        if label_octets > MAX_DNS_LABEL_OCTETS {
            return Err(format!(
                "{field} contains a label longer than {MAX_DNS_LABEL_OCTETS} octets."
            ));
        }
        wire_octets = wire_octets
            .checked_add(1 + label_octets)
            .ok_or_else(|| format!("{field} is too long."))?;
    }
    if wire_octets > MAX_DNS_WIRE_NAME_OCTETS {
        return Err(format!(
            "{field} exceeds the {MAX_DNS_WIRE_NAME_OCTETS}-octet DNS wire-name limit."
        ));
    }
    Ok(without_root.to_ascii_lowercase())
}

fn validate_txt_chunks(content: &str) -> Result<(), String> {
    if !content.trim_start().starts_with('"') {
        if content.len() > MAX_TXT_CHUNK_OCTETS {
            return Err(format!(
                "TXT record chunk exceeds {MAX_TXT_CHUNK_OCTETS} octets."
            ));
        }
        return Ok(());
    }

    let bytes = content.as_bytes();
    let mut position = 0_usize;
    let mut chunks = 0_usize;
    while position < bytes.len() {
        while position < bytes.len() && bytes[position].is_ascii_whitespace() {
            position += 1;
        }
        if position == bytes.len() {
            break;
        }
        if bytes[position] != b'"' {
            return Err("TXT content must contain only quoted chunks.".to_string());
        }
        position += 1;
        let mut chunk_octets = 0_usize;
        let mut closed = false;
        while position < bytes.len() {
            match bytes[position] {
                b'"' => {
                    position += 1;
                    closed = true;
                    break;
                }
                b'\\' => {
                    position += 1;
                    if position == bytes.len() {
                        return Err("TXT content ends with an incomplete escape.".to_string());
                    }
                    if position + 2 < bytes.len()
                        && bytes[position..position + 3].iter().all(u8::is_ascii_digit)
                    {
                        let escaped = (bytes[position] - b'0') as u16 * 100
                            + (bytes[position + 1] - b'0') as u16 * 10
                            + (bytes[position + 2] - b'0') as u16;
                        if escaped > u8::MAX as u16 {
                            return Err(
                                "TXT decimal escape must encode an octet from 000 through 255."
                                    .to_string(),
                            );
                        }
                        position += 3;
                    } else {
                        position += 1;
                    }
                    chunk_octets += 1;
                }
                _ => {
                    chunk_octets += 1;
                    position += 1;
                }
            }
            if chunk_octets > MAX_TXT_CHUNK_OCTETS {
                return Err(format!(
                    "TXT record chunk exceeds {MAX_TXT_CHUNK_OCTETS} octets."
                ));
            }
        }
        if !closed {
            return Err("TXT content contains an unterminated quoted chunk.".to_string());
        }
        chunks += 1;
        if position < bytes.len() && !bytes[position].is_ascii_whitespace() {
            return Err("Quoted TXT chunks must be separated by whitespace.".to_string());
        }
    }
    if chunks == 0 {
        return Err("TXT content must contain at least one chunk.".to_string());
    }
    Ok(())
}

fn validate_dname_owner_and_target(owner: &str, target: &str) -> Result<(), String> {
    if owner.is_empty() || owner.starts_with("*.") {
        return Err("DNAME owner must be a concrete non-root domain name.".to_string());
    }
    if target == owner || target.ends_with(&format!(".{owner}")) {
        return Err("DNAME target must not equal or be below its owner.".to_string());
    }
    Ok(())
}

fn validate_dname_hierarchy<'a>(
    records: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Result<(), String> {
    let records = records.into_iter().collect::<Vec<_>>();
    let dname_owners = records
        .iter()
        .filter(|(_, record_type)| *record_type == "DNAME")
        .map(|(owner, _)| *owner)
        .collect::<HashSet<_>>();

    for (owner, _) in records {
        let mut ancestor = owner;
        while let Some((_, parent)) = ancestor.split_once('.') {
            ancestor = parent;
            if dname_owners.contains(ancestor) {
                return Err(format!(
                    "RFC 6672 forbids record owner '{owner}' beneath DNAME owner '{ancestor}'."
                ));
            }
        }
    }
    Ok(())
}

fn validate_coexistence(owner: &str, record_types: &[String], zone: &str) -> Result<(), String> {
    let cname_count = record_types
        .iter()
        .filter(|record_type| record_type.as_str() == "CNAME")
        .count();
    if cname_count > 0 && record_types.len() > 1 {
        return Err("CNAME owner cannot coexist with any other DNS record.".to_string());
    }

    let dname_count = record_types
        .iter()
        .filter(|record_type| record_type.as_str() == "DNAME")
        .count();
    if dname_count > 1 {
        return Err("DNAME owner cannot contain multiple DNAME records.".to_string());
    }
    if dname_count > 0
        && owner != zone
        && record_types.iter().any(|record_type| record_type == "NS")
    {
        return Err("DNAME may coexist with NS only at the zone apex.".to_string());
    }
    Ok(())
}

fn reject_apex_authority_mutation(
    owner: &str,
    record_type: &str,
    zone: &str,
) -> Result<(), String> {
    if owner == zone && (record_type == "SOA" || record_type == "NS") {
        return Err(format!(
            "Unsafe apex {record_type} mutation is blocked; use the provider's authoritative zone controls."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn provider_record(
        id: &str,
        zone_id: &str,
        zone_name: &str,
        name: &str,
        record_type: &str,
    ) -> DNSRecord {
        DNSRecord {
            id: Some(id.to_string()),
            r#type: record_type.to_string(),
            name: name.to_string(),
            content: "provider-content".to_string(),
            comment: None,
            ttl: Some(300),
            priority: None,
            proxied: None,
            zone_id: zone_id.to_string(),
            zone_name: zone_name.to_string(),
            created_on: String::new(),
            modified_on: String::new(),
        }
    }

    fn zone(records: Vec<DNSRecord>) -> AuthoritativeDnsZone {
        authoritative_zone_from_lookup("zone-1", Ok(records)).unwrap()
    }

    fn base_zone() -> AuthoritativeDnsZone {
        zone(vec![provider_record(
            "existing",
            "zone-1",
            "example.com",
            "existing.example.com",
            "A",
        )])
    }

    fn record(name: &str, record_type: &str, content: &str) -> Value {
        json!({
            "name": name,
            "type": record_type,
            "content": content,
            "ttl": MAX_RFC2181_TTL,
            "other_record_types_at_owner": []
        })
    }

    fn create_args(record: Value) -> Value {
        json!({"record": record})
    }

    #[test]
    fn authoritative_lookup_failure_and_unestablished_zone_fail_closed() {
        let failed =
            authoritative_zone_from_lookup("zone-1", Err("provider unavailable".to_string()))
                .unwrap_err();
        assert!(failed.contains("failed closed"));
        assert!(failed.contains("provider unavailable"));

        let empty = authoritative_zone_from_lookup("zone-1", Ok(Vec::new())).unwrap_err();
        assert!(empty.contains("cannot be established"));
    }

    #[test]
    fn mismatched_zone_and_record_id_fail_closed() {
        let mismatch = authoritative_zone_from_lookup(
            "zone-1",
            Ok(vec![provider_record(
                "foreign",
                "zone-2",
                "example.net",
                "www.example.net",
                "A",
            )]),
        )
        .unwrap_err();
        assert!(mismatch.contains("zone-2"));
        assert!(mismatch.contains("zone-1"));

        let state = base_zone();
        let missing = validate_delete(&json!({"record_id": "foreign"}), &state).unwrap_err();
        assert!(missing.contains("did not find record ID"));
    }

    #[test]
    fn spoofed_apex_soa_and_ns_metadata_cannot_bypass_protection() {
        for record_type in ["SOA", "NS"] {
            let state = zone(vec![provider_record(
                "authority",
                "zone-1",
                "example.com",
                "example.com",
                record_type,
            )]);
            let update = json!({
                "record_id": "authority",
                "current_record_name": "www.example.com",
                "current_record_type": "A",
                "record": record("www.example.com", "A", "192.0.2.1")
            });
            assert!(validate_update(&update, &state)
                .unwrap_err()
                .contains(&format!("apex {record_type}")));

            let delete = json!({
                "record_id": "authority",
                "record_name": "www.example.com",
                "record_type": "A"
            });
            assert!(validate_delete(&delete, &state)
                .unwrap_err()
                .contains(&format!("apex {record_type}")));

            let bulk = json!({
                "records": [{
                    "record_id": "authority",
                    "name": "www.example.com",
                    "type": "A"
                }]
            });
            assert!(validated_bulk_delete_ids(&bulk, &state)
                .unwrap_err()
                .contains(&format!("apex {record_type}")));
        }
    }

    #[test]
    fn spoofed_cname_and_dname_coexistence_metadata_cannot_bypass_protection() {
        let cname_state = zone(vec![
            provider_record(
                "alias",
                "zone-1",
                "example.com",
                "alias.example.com",
                "CNAME",
            ),
            provider_record("victim", "zone-1", "example.com", "victim.example.com", "A"),
        ]);
        let mut replacement = record("alias.example.com", "A", "192.0.2.1");
        replacement["other_record_types_at_owner"] = json!([]);
        assert!(validate_update(
            &json!({"record_id": "victim", "record": replacement}),
            &cname_state
        )
        .unwrap_err()
        .contains("CNAME owner"));

        let dname_state = zone(vec![
            provider_record(
                "delegation",
                "zone-1",
                "example.com",
                "delegated.example.com",
                "NS",
            ),
            provider_record("victim", "zone-1", "example.com", "victim.example.com", "A"),
        ]);
        let mut dname = record("delegated.example.com", "DNAME", "replacement.example.net");
        dname["other_record_types_at_owner"] = json!([]);
        assert!(validate_update(
            &json!({"record_id": "victim", "record": dname}),
            &dname_state
        )
        .unwrap_err()
        .contains("DNAME may coexist with NS"));
    }

    #[test]
    fn caller_zone_and_record_claim_mismatches_are_rejected() {
        let state = base_zone();
        assert!(validate_delete(
            &json!({"record_id": "existing", "zone_name": "example.net"}),
            &state
        )
        .unwrap_err()
        .contains("does not match authoritative zone"));
        assert!(validate_delete(
            &json!({"record_id": "existing", "record_name": "other.example.com"}),
            &state
        )
        .unwrap_err()
        .contains("does not match authoritative owner"));
        assert!(validate_delete(
            &json!({"record_id": "existing", "record_type": "AAAA"}),
            &state
        )
        .unwrap_err()
        .contains("does not match authoritative type"));
    }

    #[test]
    fn rfc1035_label_wire_trailing_and_root_boundaries() {
        let label_63 = "a".repeat(63);
        assert!(canonical_domain_name(&format!("{label_63}.example."), "name").is_ok());
        let label_64 = "a".repeat(64);
        assert!(canonical_domain_name(&format!("{label_64}.example"), "name").is_err());

        let wire_255 = format!(
            "{}.{}.{}.{}.",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(61)
        );
        assert!(canonical_domain_name(&wire_255, "name").is_ok());
        let wire_256 = format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(62)
        );
        assert!(canonical_domain_name(&wire_256, "name").is_err());
        assert_eq!(canonical_domain_name(".", "name").unwrap(), "");
        assert!(canonical_domain_name("a..example", "name").is_err());
    }

    #[test]
    fn txt_character_string_octet_boundaries_and_escapes_are_enforced() {
        assert!(validate_txt_chunks(&"x".repeat(255)).is_ok());
        assert!(validate_txt_chunks(&"x".repeat(256)).is_err());
        let quoted = format!("\"{}\" \"{}\"", "x".repeat(255), "y".repeat(255));
        assert!(validate_txt_chunks(&quoted).is_ok());
        let oversized = format!("\"{}\"", "x".repeat(256));
        assert!(validate_txt_chunks(&oversized).is_err());
        assert!(validate_txt_chunks("\"\\255\"").is_ok());
        assert!(validate_txt_chunks("\"\\256\"").is_err());
        assert!(validate_txt_chunks("\"unterminated").is_err());
    }

    #[test]
    fn rfc2181_ttl_boundaries_are_enforced() {
        let state = base_zone();
        for ttl in [0, MAX_RFC2181_TTL] {
            let mut candidate = record("www.example.com", "A", "192.0.2.1");
            candidate["ttl"] = json!(ttl);
            assert!(validate_create(&create_args(candidate), &state).is_ok());
        }

        let mut too_large = record("www.example.com", "A", "192.0.2.1");
        too_large["ttl"] = json!(MAX_RFC2181_TTL + 1);
        assert!(validate_create(&create_args(too_large), &state).is_err());

        let mut negative = record("www.example.com", "A", "192.0.2.1");
        negative["ttl"] = json!(-1);
        assert!(validate_create(&create_args(negative), &state).is_err());

        let mut fractional = record("www.example.com", "A", "192.0.2.1");
        fractional["ttl"] = json!(1.5);
        assert!(validate_create(&create_args(fractional), &state).is_err());
    }

    #[test]
    fn cname_owner_exclusivity_is_bidirectional_and_authoritative() {
        let state = zone(vec![provider_record(
            "address",
            "zone-1",
            "example.com",
            "alias.example.com",
            "A",
        )]);
        assert!(validate_create(
            &create_args(record("alias.example.com", "CNAME", "target.example.net")),
            &state
        )
        .is_err());

        let state = zone(vec![provider_record(
            "alias",
            "zone-1",
            "example.com",
            "alias.example.com",
            "CNAME",
        )]);
        assert!(validate_create(
            &create_args(record("alias.example.com", "A", "192.0.2.1")),
            &state
        )
        .is_err());
    }

    #[test]
    fn rfc6672_dname_owner_target_and_coexistence_constraints() {
        let state = base_zone();
        assert!(validate_create(
            &create_args(record("old.example.com", "DNAME", "new.example.net")),
            &state
        )
        .is_ok());
        assert!(validate_create(
            &create_args(record("old.example.com", "DNAME", "loop.old.example.com")),
            &state
        )
        .is_err());
        assert!(validate_create(
            &create_args(record("*.example.com", "DNAME", "new.example.net")),
            &state
        )
        .is_err());

        let delegated = zone(vec![provider_record(
            "delegation",
            "zone-1",
            "example.com",
            "old.example.com",
            "NS",
        )]);
        assert!(validate_create(
            &create_args(record("old.example.com", "DNAME", "new.example.net")),
            &delegated
        )
        .is_err());

        let apex = zone(vec![
            provider_record("soa", "zone-1", "example.com", "example.com", "SOA"),
            provider_record("ns", "zone-1", "example.com", "example.com", "NS"),
        ]);
        assert!(validate_create(
            &create_args(record("example.com", "DNAME", "example.net")),
            &apex
        )
        .is_ok());
    }

    #[test]
    fn rfc6672_dname_subtree_rules_cover_create_update_and_canonical_names() {
        let dname_state = zone(vec![provider_record(
            "dname",
            "zone-1",
            "EXAMPLE.COM.",
            "Redirect.Example.COM.",
            "dname",
        )]);
        let beneath_existing = create_args(record("WWW.REDIRECT.EXAMPLE.COM.", "A", "192.0.2.1"));
        assert!(validate_create(&beneath_existing, &dname_state)
            .unwrap_err()
            .contains("RFC 6672"));

        let descendant_state = zone(vec![provider_record(
            "descendant",
            "zone-1",
            "example.com",
            "www.redirect.example.com",
            "A",
        )]);
        let above_descendant =
            create_args(record("REDIRECT.EXAMPLE.COM.", "DNAME", "example.net."));
        assert!(validate_create(&above_descendant, &descendant_state)
            .unwrap_err()
            .contains("RFC 6672"));

        let update_beneath_state = zone(vec![
            provider_record(
                "dname",
                "zone-1",
                "example.com",
                "redirect.example.com",
                "DNAME",
            ),
            provider_record(
                "victim",
                "zone-1",
                "example.com",
                "outside.example.com",
                "A",
            ),
        ]);
        let update_beneath = json!({
            "record_id": "victim",
            "record": record("child.redirect.example.com.", "AAAA", "2001:db8::1")
        });
        assert!(validate_update(&update_beneath, &update_beneath_state)
            .unwrap_err()
            .contains("RFC 6672"));

        let update_above_state = zone(vec![
            provider_record(
                "descendant",
                "zone-1",
                "example.com",
                "child.redirect.example.com",
                "A",
            ),
            provider_record(
                "victim",
                "zone-1",
                "example.com",
                "outside.example.com",
                "A",
            ),
        ]);
        let update_above = json!({
            "record_id": "victim",
            "record": record("Redirect.Example.Com.", "dname", "example.net")
        });
        assert!(validate_update(&update_above, &update_above_state)
            .unwrap_err()
            .contains("RFC 6672"));
    }

    #[test]
    fn rfc6672_dname_subtree_rules_cover_bulk_and_provider_snapshots() {
        let state = base_zone();
        let bulk = json!({
            "records": [
                record("redirect.example.com", "DNAME", "example.net"),
                record("child.redirect.example.com", "A", "192.0.2.1")
            ]
        });
        assert!(validate_bulk_create(&bulk, &state)
            .unwrap_err()
            .contains("RFC 6672"));

        let malformed_snapshot = authoritative_zone_from_lookup(
            "zone-1",
            Ok(vec![
                provider_record(
                    "dname",
                    "zone-1",
                    "EXAMPLE.COM.",
                    "Redirect.Example.Com.",
                    "DNAME",
                ),
                provider_record(
                    "child",
                    "zone-1",
                    "example.com",
                    "Child.Redirect.Example.Com",
                    "A",
                ),
            ]),
        )
        .unwrap_err();
        assert!(malformed_snapshot.contains("failed closed"));
        assert!(malformed_snapshot.contains("RFC 6672"));
    }

    #[test]
    fn bulk_create_checks_authoritative_and_batch_cname_conflicts() {
        let state = base_zone();
        let args = json!({
            "records": [
                record("same.example.com", "A", "192.0.2.1"),
                record("same.example.com", "CNAME", "target.example.net")
            ]
        });
        assert!(validate_bulk_create(&args, &state).is_err());

        let state = zone(vec![provider_record(
            "existing-cname",
            "zone-1",
            "example.com",
            "same.example.com",
            "CNAME",
        )]);
        let args = json!({"records": [record("same.example.com", "A", "192.0.2.1")]});
        assert!(validate_bulk_create(&args, &state).is_err());
    }

    #[test]
    fn apex_authority_creates_and_bulk_deletes_are_blocked() {
        let state = base_zone();
        for record_type in ["SOA", "NS"] {
            assert!(validate_create(
                &create_args(record("example.com", record_type, "ns1.example.net")),
                &state
            )
            .is_err());
            assert!(validate_bulk_create(
                &json!({"records": [record("@", record_type, "ns1.example.net")]}),
                &state
            )
            .is_err());
        }

        let state = zone(vec![provider_record(
            "authority",
            "zone-1",
            "example.com",
            "example.com",
            "NS",
        )]);
        assert!(validated_bulk_delete_ids(&json!({"record_ids": ["authority"]}), &state).is_err());
    }

    #[test]
    fn missing_and_ambiguous_bulk_delete_context_fails_closed() {
        let state = base_zone();
        assert!(validated_bulk_delete_ids(&json!({}), &state).is_err());
        assert!(validated_bulk_delete_ids(
            &json!({"record_ids": ["existing"], "records": []}),
            &state
        )
        .is_err());
        assert!(validated_bulk_delete_ids(
            &json!({"record_ids": ["existing", "existing"]}),
            &state
        )
        .is_err());
    }
}
