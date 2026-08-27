#!/usr/bin/env python3
"""Fail-closed validation for Better Cloudflare's narrow OSV exception policy."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import tomllib
from pathlib import Path
from typing import Any, Iterable

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
POLICY_FILENAME = "osv-scanner.toml"
POLICY_REVIEW_DEADLINE = dt.date(2026, 10, 30)
POLICY_OWNER = "Better Cloudflare security maintainers"
POLICY_REVIEW = ".github/RELEASE_SECURITY.md#osv-exception-register"
POLICY_REVIEW_HEADING = "## OSV exception register"
OSV_IMAGE = (
    "docker://ghcr.io/google/osv-scanner-action@"
    "sha256:48406c58197201fe55e56615ad9d414f85063da320e204d0b0ed460fb3908dba"
)
REQUIRED_LOCKFILES = {"Cargo.lock", "package-lock.json"}
REQUIRED_WORKFLOWS = {"ci.yml", "security.yml"}
REQUIRED_REASON_KEYS = {
    "classification",
    "owner",
    "package",
    "rationale",
    "reachability",
    "review",
}

# These are the exact findings remaining after the graph-safe upgrades. Keeping
# package/version/classification here makes policy drift and stale exceptions fail.
APPROVED_EXCEPTIONS = {
    "RUSTSEC-2024-0370": ("proc-macro-error", "1.0.4", "unmaintained"),
    "RUSTSEC-2024-0411": ("gdkwayland-sys", "0.18.2", "unmaintained"),
    "RUSTSEC-2024-0412": ("gdk", "0.18.2", "unmaintained"),
    "RUSTSEC-2024-0413": ("atk", "0.18.2", "unmaintained"),
    "RUSTSEC-2024-0414": ("gdkx11-sys", "0.18.2", "unmaintained"),
    "RUSTSEC-2024-0415": ("gtk", "0.18.2", "unmaintained"),
    "RUSTSEC-2024-0416": ("atk-sys", "0.18.2", "unmaintained"),
    "RUSTSEC-2024-0417": ("gdkx11", "0.18.2", "unmaintained"),
    "RUSTSEC-2024-0418": ("gdk-sys", "0.18.2", "unmaintained"),
    "RUSTSEC-2024-0419": ("gtk3-macros", "0.18.2", "unmaintained"),
    "RUSTSEC-2024-0420": ("gtk-sys", "0.18.2", "unmaintained"),
    "RUSTSEC-2024-0429": ("glib", "0.18.5", "unsound"),
    "RUSTSEC-2025-0075": ("unic-char-range", "0.9.0", "unmaintained"),
    "RUSTSEC-2025-0080": ("unic-common", "0.9.0", "unmaintained"),
    "RUSTSEC-2025-0081": ("unic-char-property", "0.9.0", "unmaintained"),
    "RUSTSEC-2025-0098": ("unic-ucd-version", "0.9.0", "unmaintained"),
    "RUSTSEC-2025-0100": ("unic-ucd-ident", "0.9.0", "unmaintained"),
}

GTK_BINDING_RATIONALE = (
    "GTK3 bindings are archived and have no patched GTK3 release, while GTK4 "
    "requires an upstream Tauri runtime migration"
)
UNIC_RATIONALE = (
    "the advisory is maintenance-only and urlpattern 0.3 has no compatible "
    "release that removes the archived rust-unic stack"
)
APPROVED_JUSTIFICATIONS = {
    "RUSTSEC-2024-0370": (
        "transitive build dependency through GTK3 macros",
        "the advisory is maintenance-only and the current Tauri GTK3 stack has "
        "no compatible release that removes proc-macro-error",
    ),
    "RUSTSEC-2024-0411": (
        "transitive through Tauri 2.11.1 GTK3 runtime",
        GTK_BINDING_RATIONALE,
    ),
    "RUSTSEC-2024-0412": (
        "transitive through Tauri 2.11.1 GTK3 runtime",
        GTK_BINDING_RATIONALE,
    ),
    "RUSTSEC-2024-0413": (
        "transitive through Tauri 2.11.1 GTK3 runtime",
        GTK_BINDING_RATIONALE,
    ),
    "RUSTSEC-2024-0414": (
        "transitive through Tauri 2.11.1 GTK3 runtime",
        GTK_BINDING_RATIONALE,
    ),
    "RUSTSEC-2024-0415": (
        "transitive through Tauri 2.11.1 Linux runtime",
        GTK_BINDING_RATIONALE,
    ),
    "RUSTSEC-2024-0416": (
        "transitive through Tauri 2.11.1 GTK3 runtime",
        GTK_BINDING_RATIONALE,
    ),
    "RUSTSEC-2024-0417": (
        "transitive through Tauri 2.11.1 GTK3 runtime",
        GTK_BINDING_RATIONALE,
    ),
    "RUSTSEC-2024-0418": (
        "transitive through Tauri 2.11.1 GTK3 runtime",
        GTK_BINDING_RATIONALE,
    ),
    "RUSTSEC-2024-0419": (
        "transitive build dependency through Tauri 2.11.1 GTK3 runtime",
        GTK_BINDING_RATIONALE,
    ),
    "RUSTSEC-2024-0420": (
        "transitive through Tauri 2.11.1 Linux runtime",
        GTK_BINDING_RATIONALE,
    ),
    "RUSTSEC-2024-0429": (
        "transitive through Tauri 2.11.1 GTK3 runtime with no direct application "
        "glib use",
        "the fix starts at glib 0.20 but gtk 0.18 requires glib 0.18, so no "
        "patched version is solver-reachable without replacing the upstream GTK3 "
        "runtime",
    ),
    "RUSTSEC-2025-0075": (
        "transitive through Tauri utils and urlpattern",
        UNIC_RATIONALE,
    ),
    "RUSTSEC-2025-0080": (
        "transitive through Tauri utils and urlpattern",
        UNIC_RATIONALE,
    ),
    "RUSTSEC-2025-0081": (
        "transitive through Tauri utils and urlpattern",
        UNIC_RATIONALE,
    ),
    "RUSTSEC-2025-0098": (
        "transitive through Tauri utils and urlpattern",
        UNIC_RATIONALE,
    ),
    "RUSTSEC-2025-0100": (
        "transitive through Tauri utils and urlpattern",
        UNIC_RATIONALE,
    ),
}

# Exact vulnerability IDs eliminated by the mandatory package upgrades. They
# must never be converted into policy exceptions.
FIXABLE_IDS = {
    "GHSA-7gcf-g7xr-8hxj",  # serde_with < 3.21.0
    "GHSA-7gmj-67g7-phm9",  # tauri < 2.11.1
    "GHSA-8c75-8mhr-p7r9",  # openssl < 0.10.80
    "GHSA-ghm9-cr32-g9qj",
    "GHSA-hppc-g8h3-xhp3",
    "GHSA-phqj-4mhp-q6mq",
    "GHSA-pqf5-4pqq-29f5",
    "GHSA-xmgf-hq76-4vx2",
    "GHSA-xp3w-r5p5-63rr",
    "GHSA-xv59-967r-8726",
}

MINIMUM_VERSIONS = {
    # keyring 2.x reaches the credential store through secret-service and
    # zbus 3, which is what kept derivative (RUSTSEC-2024-0388) and instant
    # (RUSTSEC-2024-0384) in the graph. keyring 4 uses its own backend
    # crates and drops both, so this floor is what keeps those two
    # exceptions retired.
    "keyring": "4.1.6",
    "openssl": "0.10.80",
    "serde_with": "3.21.0",
    "tauri": "2.11.1",
    "tauri-build": "2.6.3",
    "tauri-codegen": "2.6.3",
    "tauri-macros": "2.6.3",
    # tauri-plugin 2.5.x selects the tauri-utils "build" feature, which pulls the
    # archived kuchikiki/selectors HTML stack back in and resurrects the retired
    # RUSTSEC-2025-0057 (fxhash) and RUSTSEC-2026-0097 (rand 0.7.3) findings.
    # 2.6.3 selects "build-2" (dom_query) instead, so this floor is what keeps
    # those two exceptions retired.
    "tauri-plugin": "2.6.3",
    "tauri-runtime": "2.11.3",
    "tauri-runtime-wry": "2.11.4",
    "tauri-utils": "2.9.3",
}


class PolicyError(ValueError):
    """Raised when the policy contract is not fail-closed."""


def _read_toml(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise PolicyError(f"{label} path does not exist: {path}")
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise PolicyError(f"{label} is not valid TOML: {path}: {error}") from error


def _parse_version(value: str) -> tuple[int, ...]:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", value)
    if not match:
        raise PolicyError(f"unsupported package version in Cargo.lock: {value}")
    return tuple(int(part) for part in match.groups())


def _parse_reason(reason: Any, advisory_id: str) -> dict[str, str]:
    if not isinstance(reason, str):
        raise PolicyError(f"{advisory_id}: reason must be a string")
    metadata: dict[str, str] = {}
    for item in reason.split(";"):
        key, separator, value = item.strip().partition("=")
        if not separator or not key or not value.strip():
            raise PolicyError(f"{advisory_id}: malformed reason metadata: {item!r}")
        if key in metadata:
            raise PolicyError(f"{advisory_id}: duplicate reason key: {key}")
        metadata[key] = value.strip()
    if set(metadata) != REQUIRED_REASON_KEYS:
        raise PolicyError(
            f"{advisory_id}: reason keys must be exactly "
            f"{sorted(REQUIRED_REASON_KEYS)}, got {sorted(metadata)}"
        )
    for key in ("owner", "rationale", "reachability", "review"):
        if len(metadata[key]) < 12:
            raise PolicyError(f"{advisory_id}: {key} is not sufficiently specific")
    if "transitive" not in metadata["reachability"].lower():
        raise PolicyError(f"{advisory_id}: reachability must prove transitive status")
    return metadata


def _normalise_expiry(value: Any, advisory_id: str) -> dt.date:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    raise PolicyError(f"{advisory_id}: ignoreUntil must be a TOML date")


def validate_config(
    config_path: Path, cargo_lock_path: Path, *, today: dt.date | None = None
) -> set[str]:
    today = today or dt.datetime.now(dt.timezone.utc).date()
    if config_path.resolve().parent != REPOSITORY_ROOT:
        raise PolicyError("OSV config must be at the repository root")
    if config_path.name != POLICY_FILENAME:
        raise PolicyError(f"OSV config must be named {POLICY_FILENAME}")

    config = _read_toml(config_path, "OSV config")
    if set(config) != {"IgnoredVulns"}:
        raise PolicyError("OSV config may contain only exact IgnoredVulns entries")
    entries = config.get("IgnoredVulns")
    if not isinstance(entries, list) or not entries:
        raise PolicyError("OSV config must contain a non-empty IgnoredVulns array")

    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"id", "ignoreUntil", "reason"}:
            raise PolicyError(
                "each ignore entry must contain exactly id, ignoreUntil, and reason"
            )
        advisory_id = entry["id"]
        if not isinstance(advisory_id, str):
            raise PolicyError(f"advisory ID must be a string: {advisory_id!r}")
        if advisory_id in seen:
            raise PolicyError(f"duplicate ignored advisory: {advisory_id}")
        if advisory_id in FIXABLE_IDS:
            raise PolicyError(f"fixable advisory may not be ignored: {advisory_id}")
        if not re.fullmatch(r"RUSTSEC-\d{4}-\d{4}", advisory_id):
            raise PolicyError(f"invalid exact RustSec advisory ID: {advisory_id!r}")
        if advisory_id not in APPROVED_EXCEPTIONS:
            raise PolicyError(f"unapproved advisory may not be ignored: {advisory_id}")
        seen.add(advisory_id)

        expiry = _normalise_expiry(entry["ignoreUntil"], advisory_id)
        if expiry <= today:
            raise PolicyError(f"{advisory_id}: ignore expired on {expiry.isoformat()}")
        if expiry > POLICY_REVIEW_DEADLINE:
            raise PolicyError(
                f"{advisory_id}: ignore exceeds review deadline "
                f"{POLICY_REVIEW_DEADLINE.isoformat()}"
            )

        package, version, classification = APPROVED_EXCEPTIONS[advisory_id]
        metadata = _parse_reason(entry["reason"], advisory_id)
        if metadata["package"] != f"{package}@{version}":
            raise PolicyError(f"{advisory_id}: package/version rationale drifted")
        if metadata["classification"] != classification:
            raise PolicyError(f"{advisory_id}: classification rationale drifted")
        expected_reachability, expected_rationale = APPROVED_JUSTIFICATIONS[
            advisory_id
        ]
        expected_metadata = {
            "classification": classification,
            "owner": POLICY_OWNER,
            "package": f"{package}@{version}",
            "rationale": expected_rationale,
            "reachability": expected_reachability,
            "review": POLICY_REVIEW,
        }
        if metadata != expected_metadata:
            drifted = sorted(
                key
                for key in REQUIRED_REASON_KEYS
                if metadata[key] != expected_metadata[key]
            )
            raise PolicyError(
                f"{advisory_id}: reviewed reason metadata drifted: {drifted}"
            )

    expected = set(APPROVED_EXCEPTIONS)
    if seen != expected:
        missing = sorted(expected - seen)
        extra = sorted(seen - expected)
        raise PolicyError(f"policy ID set drifted: missing={missing}, extra={extra}")

    cargo_lock = _read_toml(cargo_lock_path, "Cargo lockfile")
    packages = cargo_lock.get("package")
    if not isinstance(packages, list):
        raise PolicyError("Cargo.lock does not contain a package array")
    versions: dict[str, set[str]] = {}
    for package in packages:
        if isinstance(package, dict):
            name = package.get("name")
            version = package.get("version")
            if isinstance(name, str) and isinstance(version, str):
                versions.setdefault(name, set()).add(version)

    for advisory_id, (package, version, _) in APPROVED_EXCEPTIONS.items():
        if version not in versions.get(package, set()):
            raise PolicyError(
                f"{advisory_id}: stale exception, {package}@{version} is absent"
            )
    for package, minimum in MINIMUM_VERSIONS.items():
        resolved = versions.get(package, set())
        if not resolved:
            raise PolicyError(f"required package is absent: {package}")
        if any(_parse_version(version) < _parse_version(minimum) for version in resolved):
            raise PolicyError(
                f"{package} resolved below security floor {minimum}: {sorted(resolved)}"
            )

    review_document = REPOSITORY_ROOT / POLICY_REVIEW.partition("#")[0]
    if not review_document.is_file():
        raise PolicyError(f"policy review document does not exist: {review_document}")
    if POLICY_REVIEW_HEADING not in review_document.read_text(encoding="utf-8"):
        raise PolicyError(
            f"policy review anchor is absent from {review_document}: "
            f"{POLICY_REVIEW_HEADING}"
        )

    return seen


def validate_lockfile_paths(lockfiles: Iterable[Path]) -> tuple[Path, Path]:
    paths = tuple(lockfiles)
    names = {path.name for path in paths}
    if len(paths) != 2 or names != REQUIRED_LOCKFILES:
        raise PolicyError(
            f"lockfiles must be exactly {sorted(REQUIRED_LOCKFILES)}, got {sorted(names)}"
        )
    for path in paths:
        if not path.is_file():
            raise PolicyError(f"lockfile path does not exist: {path}")
        if path.resolve().parent != REPOSITORY_ROOT:
            raise PolicyError(f"lockfile must be at repository root: {path}")

    package_lock = next(path for path in paths if path.name == "package-lock.json")
    try:
        parsed = json.loads(package_lock.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PolicyError(f"package-lock.json is invalid: {error}") from error
    if not isinstance(parsed, dict) or not isinstance(parsed.get("packages"), dict):
        raise PolicyError("package-lock.json does not contain the npm packages map")

    cargo_lock = next(path for path in paths if path.name == "Cargo.lock")
    return cargo_lock, package_lock


def _step_block(text: str, needle: str, name: str) -> str:
    matches = list(re.finditer(re.escape(needle), text))
    if len(matches) != 1:
        raise PolicyError(f"{name}: expected exactly one step containing {needle}")
    position = matches[0].start()
    step_starts = list(re.finditer(r"(?m)^(\s*)- name:\s*.*$", text[:position]))
    if not step_starts:
        raise PolicyError(f"{name}: {needle} is not inside a named step")
    start_match = step_starts[-1]
    indentation = re.escape(start_match.group(1))
    next_step = re.search(rf"(?m)^{indentation}- name:\s*", text[position:])
    next_job = re.search(r"(?m)^  [A-Za-z0-9_-]+:\s*$", text[position:])
    boundaries = [
        match.start() for match in (next_step, next_job) if match is not None
    ]
    end = position + min(boundaries) if boundaries else len(text)
    return text[start_match.start() : end]


def _job_block(text: str, position: int, name: str) -> tuple[str, str, int]:
    job_starts = list(
        re.finditer(r"(?m)^  ([A-Za-z0-9_-]+):\s*$", text[:position])
    )
    if not job_starts:
        raise PolicyError(f"{name}: critical OSV step is not inside a job")
    start_match = job_starts[-1]
    next_job = re.search(r"(?m)^  [A-Za-z0-9_-]+:\s*$", text[position:])
    end = position + next_job.start() if next_job else len(text)
    return (
        start_match.group(1),
        text[start_match.start() : end],
        start_match.start(),
    )


def _reject_conditional_step(name: str, label: str, block: str) -> None:
    if re.search(r"""(?m)^\s+(?:if|"if"|'if')\s*:""", block):
        raise PolicyError(f"{name}: {label} step must be unconditional")


def validate_workflow_text(name: str, text: str) -> None:
    if re.search(
        r"""(?m)^\s*"""
        r"""(?:continue-on-error|"continue-on-error"|'continue-on-error')\s*:""",
        text,
    ):
        raise PolicyError(f"{name}: continue-on-error is forbidden")
    if text.count(OSV_IMAGE) != 1:
        raise PolicyError(f"{name}: must use the pinned OSV v2.3.8 image exactly once")
    validator = "python3 .github/scripts/validate-osv-policy.py"
    scanner_step = _step_block(text, OSV_IMAGE, name)
    validator_step = _step_block(text, validator, name)
    scanner_position = text.index(scanner_step)
    validator_position = text.index(validator_step)
    scanner_job, scanner_job_block, scanner_job_position = _job_block(
        text, scanner_position, name
    )
    validator_job, _, validator_job_position = _job_block(
        text, validator_position, name
    )
    expected_job = {"ci.yml": "release_contract", "security.yml": "osv"}.get(name)
    if (
        expected_job is None
        or scanner_job != expected_job
        or validator_job != expected_job
    ):
        raise PolicyError(
            f"{name}: validator and scanner must remain in the expected OSV job "
            f"{expected_job!r}"
        )
    if scanner_job_position != validator_job_position:
        raise PolicyError(f"{name}: validator and scanner must remain in the same job")
    if validator_position >= scanner_position:
        raise PolicyError(f"{name}: policy validator must run before the scanner")

    expected_job_condition = {
        "ci.yml": None,
        "security.yml": "github.event_name != 'pull_request'",
    }[name]
    job_conditions = re.findall(
        r"""(?m)^    (?:if|"if"|'if')\s*:\s*(.*?)\s*$""",
        scanner_job_block,
    )
    expected_conditions = (
        [] if expected_job_condition is None else [expected_job_condition]
    )
    if job_conditions != expected_conditions:
        raise PolicyError(
            f"{name}: {expected_job} job condition drifted: {job_conditions}"
        )

    _reject_conditional_step(name, "policy validator", validator_step)
    _reject_conditional_step(name, "scanner", scanner_step)
    active_image = re.findall(
        rf"(?m)^\s+uses:\s*{re.escape(OSV_IMAGE)}(?:\s+#.*)?\s*$",
        scanner_step,
    )
    if len(active_image) != 1:
        raise PolicyError(f"{name}: scanner step must actively use the pinned image")
    active_validator = re.findall(
        rf"(?m)^\s+{re.escape(validator)}\s*$",
        validator_step,
    )
    if len(active_validator) != 1:
        raise PolicyError(
            f"{name}: validator step must actively run the policy validator"
        )
    for argument in (
        "--config=./osv-scanner.toml",
        "--lockfile=./Cargo.lock",
        "--lockfile=./package-lock.json",
    ):
        active_argument = rf"(?m)^\s+{re.escape(argument)}\s*$"
        if len(re.findall(active_argument, scanner_step)) != 1:
            raise PolicyError(
                f"{name}: scanner step must pass {argument} exactly once"
            )
        if len(re.findall(active_argument, validator_step)) != 1:
            raise PolicyError(
                f"{name}: policy validator step must pass {argument} exactly once"
            )
    for workflow in ("./.github/workflows/ci.yml", "./.github/workflows/security.yml"):
        active_workflow = rf"(?m)^\s+{re.escape(f'--workflow={workflow}')}\s*$"
        if len(re.findall(active_workflow, validator_step)) != 1:
            raise PolicyError(f"{name}: validator must inspect {workflow}")


def validate_workflows(workflows: Iterable[Path]) -> None:
    paths = tuple(workflows)
    names = {path.name for path in paths}
    if len(paths) != 2 or names != REQUIRED_WORKFLOWS:
        raise PolicyError(
            f"workflows must be exactly {sorted(REQUIRED_WORKFLOWS)}, got {sorted(names)}"
        )
    for path in paths:
        if not path.is_file():
            raise PolicyError(f"workflow path does not exist: {path}")
        if path.resolve().parent != REPOSITORY_ROOT / ".github" / "workflows":
            raise PolicyError(f"workflow must be under .github/workflows: {path}")
        validate_workflow_text(path.name, path.read_text(encoding="utf-8"))


def validate_findings(ignore_ids: set[str], findings: Iterable[dict[str, Any]]) -> None:
    """Evaluate synthetic/diagnostic findings for deterministic contract tests."""
    for finding in findings:
        ids = finding.get("ids")
        reachable_fixes = finding.get("reachable_fixed_versions", [])
        if not isinstance(ids, list) or not ids or not all(
            isinstance(item, str) for item in ids
        ):
            raise PolicyError("finding IDs must be a non-empty string array")
        matched = ignore_ids.intersection(ids)
        if not matched:
            raise PolicyError(f"unlisted advisory fails closed: {sorted(ids)}")
        if reachable_fixes:
            raise PolicyError(
                f"fixable advisory may not be ignored: {sorted(matched)} "
                f"reachable_fixes={reachable_fixes}"
            )


def validate_policy(
    config: Path,
    lockfiles: Iterable[Path],
    workflows: Iterable[Path],
    *,
    today: dt.date | None = None,
) -> None:
    cargo_lock, _ = validate_lockfile_paths(lockfiles)
    validate_config(config, cargo_lock, today=today)
    validate_workflows(workflows)


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument(
        "--lockfile", required=True, action="append", type=Path, dest="lockfiles"
    )
    parser.add_argument(
        "--workflow", required=True, action="append", type=Path, dest="workflows"
    )
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    try:
        validate_policy(args.config, args.lockfiles, args.workflows)
    except PolicyError as error:
        print(f"OSV policy validation failed: {error}", file=sys.stderr)
        return 1
    print(
        f"OSV policy valid: {len(APPROVED_EXCEPTIONS)} exact exceptions, "
        "2 root lockfiles, 2 fail-closed workflows"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
