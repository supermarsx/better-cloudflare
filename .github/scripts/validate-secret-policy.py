#!/usr/bin/env python3
"""Fail-closed validation for Better Cloudflare's narrow secret-scanning policy.

The Gitleaks gate is only as good as its allowlist. This validator refuses to
let the scan run unless the reviewed rule set, the reviewed path allowlist and
the reviewed scanner pin are all still exactly what the register in
`.github/RELEASE_SECURITY.md#secret-scanning-allowlist-register` describes, and
unless no allowlist entry could hide a credential in real source.
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import sys
import tomllib
from pathlib import Path
from typing import Any, Iterable

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
POLICY_RELATIVE_PATH = ".github/gitleaks.toml"
# Gitleaks reads a repository-root `.gitleaksignore` automatically. Measured
# against 8.30.1: a fingerprint listed there suppresses the finding, and
# `--gitleaks-ignore-path` pointing at an empty file elsewhere does NOT override
# it - the root file is still honoured. That makes it a second suppression
# channel sitting outside this policy, so the gate refuses to run while one
# exists with entries in it. (A `.gitleaksignore` in a subdirectory is ignored by
# gitleaks, so only the root path is guarded.)
IGNORE_RELATIVE_PATH = ".gitleaksignore"
POLICY_REVIEW = ".github/RELEASE_SECURITY.md#secret-scanning-allowlist-register"
POLICY_REVIEW_HEADING = "## Secret scanning allowlist register"
POLICY_OWNER = "Better Cloudflare security maintainers"
POLICY_REVIEW_DEADLINE = dt.date(2026, 10, 30)
REQUIRED_WORKFLOWS = {"security.yml"}

# The scanner is pinned exactly like every action and container image: fetched
# by version, rejected unless it hashes to this digest.
GITLEAKS_VERSION = "8.30.1"
GITLEAKS_SHA256 = "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

# Reviewed rules. The value records which credential each rule exists for, so a
# silently deleted or repurposed rule fails the gate instead of the scan.
APPROVED_RULES = {
    "bc-cloudflare-api-token": "Cloudflare scoped API token",
    "bc-cloudflare-global-api-key": "Cloudflare Global API key",
    "bc-cloudflare-auth-email": "Cloudflare account e-mail paired with a Global API key",
    "bc-porkbun-api-key": "Porkbun API and secret API key",
    "bc-godaddy-sso-key": "GoDaddy sso-key credential pair",
    "bc-namecheap-api-key": "Namecheap API key",
    "bc-name-com-api-token": "Name.com API token",
    "bc-mcp-bearer-token": "MCP server bearer token",
    "bc-ai-provider-api-key": "Anthropic and OpenAI API keys",
}

# Reviewed path allowlist. Nothing else may be suppressed, and every entry is
# reproduced verbatim in the register document.
#
# Every entry here skips a whole file: `paths` in a global allowlist is a file
# filter, not a qualifier, and a `gitleaks dir` run drops the file before any
# rule executes (`condition = "AND"` does not contain that; it constrains the
# git scan only). That is why this set holds only generated trees, lockfiles and
# end-to-end fictional fixtures, and why `_reject_broad_path` guards it with
# canaries. To silence one value in real source, add it to the value-scoped
# allowlist below instead of naming the file here.
APPROVED_ALLOWLIST_PATHS = {
    r"(^|/)node_modules/",
    r"(^|/)target/",
    r"^\.next/",
    r"^out/",
    r"^dist(-ssr)?/",
    r"^test-results/",
    r"^data/",
    r"^package-lock\.json$",
    r"^Cargo\.lock$",
    r"^e2e/fixtures/demo-workspace\.ts$",
    r"^e2e/fixtures/demo-panels\.ts$",
    r"^\.github/gitleaks\.toml$",
}

# The single reviewed value-scoped global allowlist. It suppresses one exact
# literal in one exact file: the OPENPGPKEY fixture in the bc-dns-tools record
# type table, which is a fake OpenPGP packet carrying the ASCII text
# "dandomKeyDataForTestingOnly". It is allowlisted rather than rewritten because
# the history scan attributes the finding to the commit that introduced the line,
# so editing the fixture today cannot clear it.
#
#
# It carries no `paths` filter and must never gain one. A `paths` filter in a
# global allowlist is a file filter: a `gitleaks dir` scan drops the whole file
# before any rule runs, so scoping this entry to import.rs would stop that file
# being scanned at all rather than narrowing what is hidden. `condition = "AND"`
# does not prevent that either, so neither key is accepted here.
APPROVED_VALUE_ALLOWLIST = {
    "regexes": [r"^mQINBGRhbmRvbUtleURhdGFGb3JUZXN0aW5nT25seQ==$"],
}

# Only this rule may carry a value-shaped allowlist, and only for reserved
# documentation domains that cannot identify a real Cloudflare account.
APPROVED_RULE_ALLOWLISTS = {
    "bc-cloudflare-auth-email": {
        "regexTarget": "match",
        "regexes": [
            r"(?i)@(?:[\w-]+\.)*(?:example\.(?:com|net|org)|test|invalid|localhost|local)\b",
        ],
    },
}

# No allowlist entry may match any of these. They stand in for the real trees
# that hold credential-shaped strings, so a blanket "ignore anything that looks
# like a test or a doc" suppression fails the gate rather than the reviewer.
PROTECTED_CANARY_PATHS = (
    ".env",
    ".env.local",
    ".github/workflows/ci.yml",
    ".github/workflows/security.yml",
    ".github/scripts/release-contract.mjs",
    "app/layout.tsx",
    "docs/reference.md",
    "docs/development.md",
    "e2e/auth-errors.spec.ts",
    "e2e/login-key-management.spec.ts",
    "e2e/fixtures/other-fixture.ts",
    "readme.md",
    "scripts/dev-server.mjs",
    "spec.md",
    "src/lib/storage/storage.ts",
    "src-tauri/crates/bc-registrar/src/porkbun.rs",
    "src-tauri/crates/bc-mcp/src/transport.rs",
    # Production zone-file parser, and the file most likely to be reached for.
    # It carries the OPENPGPKEY fixture that the value-scoped allowlist below
    # suppresses, so the tempting "simplification" is to path-allowlist the whole
    # file instead. That would blind every rule to a real source file in a
    # `gitleaks dir` run (measured: a planted Porkbun key went undetected and
    # 46142 fewer bytes were read). Listing it here makes that form permanently
    # unavailable rather than merely discouraged.
    "src-tauri/crates/bc-dns-tools/src/import.rs",
    "src-tauri/tauri.conf.json",
    "test/storageManager.test.ts",
)

ALLOWED_TOP_LEVEL_KEYS = {"title", "extend", "rules", "allowlists"}
ALLOWED_RULE_KEYS = {
    "id",
    "description",
    "regex",
    "entropy",
    "keywords",
    "allowlists",
}
ALLOWED_ALLOWLIST_KEYS = {"description", "paths"}
ALLOWED_VALUE_ALLOWLIST_KEYS = {"description", "regexes"}
ALLOWED_RULE_ALLOWLIST_KEYS = {"description", "regexTarget", "regexes"}


class PolicyError(ValueError):
    """Raised when the secret-scanning contract is not fail-closed."""


def _read_toml(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise PolicyError(f"{label} path does not exist: {path}")
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise PolicyError(f"{label} is not valid TOML: {path}: {error}") from error


def _compiled(pattern: str, label: str) -> re.Pattern[str]:
    try:
        return re.compile(pattern)
    except re.error as error:
        raise PolicyError(f"{label}: pattern does not compile: {pattern!r}: {error}")


def _validate_rules(rules: Any) -> set[str]:
    if not isinstance(rules, list) or not rules:
        raise PolicyError("policy must declare a non-empty [[rules]] array")

    seen: set[str] = set()
    for rule in rules:
        if not isinstance(rule, dict):
            raise PolicyError("each rule must be a table")
        extra = set(rule) - ALLOWED_RULE_KEYS
        if extra:
            raise PolicyError(f"rule declares unsupported keys: {sorted(extra)}")
        rule_id = rule.get("id")
        if not isinstance(rule_id, str) or rule_id not in APPROVED_RULES:
            raise PolicyError(f"unapproved or missing rule id: {rule_id!r}")
        if rule_id in seen:
            raise PolicyError(f"duplicate rule id: {rule_id}")
        seen.add(rule_id)

        description = rule.get("description")
        if not isinstance(description, str) or len(description) < 24:
            raise PolicyError(f"{rule_id}: description is not sufficiently specific")
        regex = rule.get("regex")
        if not isinstance(regex, str) or not regex:
            raise PolicyError(f"{rule_id}: rule must declare a regex")
        _compiled(regex, rule_id)
        keywords = rule.get("keywords")
        if not isinstance(keywords, list) or not keywords:
            raise PolicyError(f"{rule_id}: rule must declare keywords")
        for keyword in keywords:
            if not isinstance(keyword, str) or keyword != keyword.lower():
                raise PolicyError(f"{rule_id}: keywords must be lowercase: {keyword!r}")

        _validate_rule_allowlists(rule_id, rule.get("allowlists"))

    missing = sorted(set(APPROVED_RULES) - seen)
    if missing:
        raise PolicyError(f"reviewed rules are missing from the policy: {missing}")
    return seen


def _validate_rule_allowlists(rule_id: str, allowlists: Any) -> None:
    approved = APPROVED_RULE_ALLOWLISTS.get(rule_id)
    if allowlists is None:
        if approved is not None:
            raise PolicyError(f"{rule_id}: reviewed rule allowlist is missing")
        return
    if approved is None:
        raise PolicyError(f"{rule_id}: rule-level allowlists are not approved")
    if not isinstance(allowlists, list) or len(allowlists) != 1:
        raise PolicyError(f"{rule_id}: exactly one rule allowlist is approved")

    allowlist = allowlists[0]
    if not isinstance(allowlist, dict):
        raise PolicyError(f"{rule_id}: rule allowlist must be a table")
    extra = set(allowlist) - ALLOWED_RULE_ALLOWLIST_KEYS
    if extra:
        raise PolicyError(f"{rule_id}: rule allowlist has extra keys: {sorted(extra)}")
    if allowlist.get("regexTarget") != approved["regexTarget"]:
        raise PolicyError(f"{rule_id}: rule allowlist must target the matched value")
    if allowlist.get("regexes") != approved["regexes"]:
        raise PolicyError(f"{rule_id}: reviewed rule allowlist regexes drifted")


def _validate_allowlists(allowlists: Any) -> set[str]:
    if not isinstance(allowlists, list) or not allowlists:
        raise PolicyError("policy must declare a non-empty [[allowlists]] array")

    observed: set[str] = set()
    value_scoped = 0
    for allowlist in allowlists:
        if not isinstance(allowlist, dict):
            raise PolicyError("each global allowlist must be a table")
        description = allowlist.get("description")
        if not isinstance(description, str) or len(description) < 40:
            raise PolicyError("every global allowlist needs a reviewed justification")

        # An entry carrying either value-shaped key is judged against the one
        # reviewed value-scoped allowlist, never against the path rules, so a
        # value allowlist can neither slip through nor silently widen.
        if "regexes" in allowlist or "condition" in allowlist:
            _validate_value_allowlist(allowlist)
            value_scoped += 1
            continue

        extra = set(allowlist) - ALLOWED_ALLOWLIST_KEYS
        if extra:
            raise PolicyError(
                "global allowlists may only suppress by path, got: "
                f"{sorted(extra)}"
            )
        paths = allowlist.get("paths")
        if not isinstance(paths, list) or not paths:
            raise PolicyError("every global allowlist must list paths")
        for path in paths:
            if not isinstance(path, str) or not path:
                raise PolicyError(f"allowlist path must be a string: {path!r}")
            if path in observed:
                raise PolicyError(f"duplicate allowlist path: {path}")
            if path not in APPROVED_ALLOWLIST_PATHS:
                raise PolicyError(f"unapproved allowlist path: {path}")
            observed.add(path)
            _reject_broad_path(path)

    missing = sorted(APPROVED_ALLOWLIST_PATHS - observed)
    if missing:
        raise PolicyError(f"reviewed allowlist paths are missing: {missing}")
    if value_scoped != 1:
        raise PolicyError(
            "exactly one reviewed value-scoped allowlist is approved, found "
            f"{value_scoped}"
        )
    return observed


def _validate_value_allowlist(allowlist: dict[str, Any]) -> None:
    """Hold a value-scoped allowlist to the reviewed entry, character for character."""
    # `paths` and `condition` are refused outright rather than reviewed. A path
    # filter here would skip the whole file in a `gitleaks dir` scan instead of
    # narrowing the suppression, and `condition` is only ever needed to tame one.
    extra = set(allowlist) - ALLOWED_VALUE_ALLOWLIST_KEYS
    if extra:
        raise PolicyError(
            "global allowlists may only suppress by path; the one reviewed "
            "value-scoped entry suppresses by value alone and may not narrow "
            f"itself with {sorted(extra)}, which would skip whole files instead"
        )
    for key, expected in APPROVED_VALUE_ALLOWLIST.items():
        if allowlist.get(key) != expected:
            raise PolicyError(
                "global allowlists may only suppress by path unless they "
                "reproduce the reviewed value-scoped entry exactly; "
                f"{key} drifted to {allowlist.get(key)!r}"
            )
    # Anchoring is what keeps the entry to one literal, so it is checked rather
    # than trusted to the reviewed string above.
    for regex in APPROVED_VALUE_ALLOWLIST["regexes"]:
        if not regex.startswith("^") or not regex.endswith("$"):
            raise PolicyError(f"value-scoped allowlist regex is not anchored: {regex}")


def _reject_broad_path(path: str) -> None:
    compiled = _compiled(path, f"allowlist path {path!r}")
    matched = sorted(
        canary for canary in PROTECTED_CANARY_PATHS if compiled.search(canary)
    )
    if matched:
        raise PolicyError(
            f"allowlist path {path!r} would suppress protected files: {matched}"
        )


def validate_config(config_path: Path, *, today: dt.date | None = None) -> set[str]:
    today = today or dt.datetime.now(dt.timezone.utc).date()
    expected_path = REPOSITORY_ROOT / POLICY_RELATIVE_PATH
    if config_path.resolve() != expected_path.resolve():
        raise PolicyError(f"policy must be exactly {POLICY_RELATIVE_PATH}")

    config = _read_toml(config_path, "secret scanning policy")
    extra = set(config) - ALLOWED_TOP_LEVEL_KEYS
    if extra:
        raise PolicyError(f"policy declares unsupported sections: {sorted(extra)}")
    if config.get("extend") != {"useDefault": True}:
        raise PolicyError(
            "policy must extend the upstream ruleset with exactly "
            "[extend] useDefault = true"
        )

    rules = _validate_rules(config.get("rules"))
    _validate_allowlists(config.get("allowlists"))
    _validate_no_unreviewed_ignore_file()
    _validate_review_document(today)
    return rules


def _validate_no_unreviewed_ignore_file() -> None:
    """Refuse to scan while an unreviewed `.gitleaksignore` can suppress findings.

    Every suppression in this repository goes through the reviewed policy file so
    that it is registered, justified and covered by this validator. A root
    `.gitleaksignore` bypasses all of that: gitleaks reads it on its own, and no
    flag on the scan step turns it off.
    """
    ignore_file = REPOSITORY_ROOT / IGNORE_RELATIVE_PATH
    if not ignore_file.is_file():
        return
    entries = [
        line.strip()
        for line in ignore_file.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    if entries:
        raise PolicyError(
            f"{IGNORE_RELATIVE_PATH} is an unreviewed suppression channel and "
            f"carries {len(entries)} entry/entries: {entries[:3]}. Suppress "
            f"through {POLICY_RELATIVE_PATH} instead, where the register and "
            "this validator can hold it to review."
        )


def _validate_review_document(today: dt.date) -> None:
    if today > POLICY_REVIEW_DEADLINE:
        raise PolicyError(
            "secret scanning allowlist review expired on "
            f"{POLICY_REVIEW_DEADLINE.isoformat()}"
        )
    document = REPOSITORY_ROOT / POLICY_REVIEW.partition("#")[0]
    if not document.is_file():
        raise PolicyError(f"policy review document does not exist: {document}")
    text = document.read_text(encoding="utf-8")
    if POLICY_REVIEW_HEADING not in text:
        raise PolicyError(f"policy review anchor is absent: {POLICY_REVIEW_HEADING}")
    # Markdown tables escape the pipes inside the path patterns; compare against
    # the unescaped text so the register stays readable.
    register_raw = text.partition(POLICY_REVIEW_HEADING)[2].partition("\n## ")[0]
    register = register_raw.replace("\\|", "|")
    if POLICY_OWNER not in register:
        raise PolicyError("the register must name the reviewing owner")
    if POLICY_REVIEW_DEADLINE.isoformat() not in register:
        raise PolicyError("the register must record the reviewed expiry date")
    for rule_id in APPROVED_RULES:
        if f"`{rule_id}`" not in text:
            raise PolicyError(f"the register does not document rule {rule_id}")
    for path in APPROVED_ALLOWLIST_PATHS:
        if f"`{path}`" not in register:
            raise PolicyError(f"the register does not document allowlist path {path}")
    # Row-scoped, not a substring match: the value must be tabled like every OSV
    # exception, so a passing mention in prose cannot stand in for a register
    # entry. Cells are compared after stripping, because Prettier pads every cell
    # out to the width of the widest row - a fixed-width literal would never
    # match and the assertion would pass vacuously.
    tabled = {cell for row in _register_rows(register_raw) for cell in row}
    for regex in APPROVED_VALUE_ALLOWLIST["regexes"]:
        if f"`{regex}`" not in tabled:
            raise PolicyError(
                "the register does not table the allowlisted value "
                f"{regex} (a prose mention does not count)"
            )


def _register_rows(register: str) -> list[list[str]]:
    """Split the register's markdown tables into stripped cells, one list per row.

    Parsed from the raw register text rather than the pipe-unescaped copy, so a
    `\\|` inside a pattern cannot be mistaken for a cell boundary.
    """
    rows: list[list[str]] = []
    for line in register.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        rows.append(cells)
    return rows


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
    boundaries = [match.start() for match in (next_step, next_job) if match is not None]
    end = position + min(boundaries) if boundaries else len(text)
    return text[start_match.start() : end]


def _job_block(text: str, name: str, job: str) -> str:
    start = re.search(rf"(?m)^  {re.escape(job)}:\s*$", text)
    if start is None:
        raise PolicyError(f"{name}: the {job} job is missing")
    remainder = text[start.end() :]
    next_job = re.search(r"(?m)^  [A-Za-z0-9_-]+:\s*$", remainder)
    end = start.end() + (next_job.start() if next_job else len(remainder))
    return text[start.start() : end]


def validate_workflow_text(name: str, text: str) -> None:
    if re.search(
        r"""(?m)^\s*"""
        r"""(?:continue-on-error|"continue-on-error"|'continue-on-error')\s*:""",
        text,
    ):
        raise PolicyError(f"{name}: continue-on-error is forbidden")

    job = _job_block(text, name, "secrets")
    for required, label in (
        (rf"(?m)^      GITLEAKS_VERSION: {re.escape(GITLEAKS_VERSION)}$", "version pin"),
        (rf"(?m)^      GITLEAKS_SHA256: {re.escape(GITLEAKS_SHA256)}$", "digest pin"),
        (r"sha256sum --check --strict", "digest verification"),
        (
            r"gitleaks/releases/download/v\$\{GITLEAKS_VERSION\}/"
            r"gitleaks_\$\{GITLEAKS_VERSION\}_linux_x64\.tar\.gz",
            "pinned download",
        ),
    ):
        if len(re.findall(required, job)) != 1:
            raise PolicyError(f"{name}: secrets job must carry the {label} exactly once")

    validator = "python3 .github/scripts/validate-secret-policy.py"
    validator_step = _step_block(job, validator, name)
    if len(re.findall(rf"(?m)^\s+{re.escape(validator)}\s*$", validator_step)) != 1:
        raise PolicyError(f"{name}: validator step must actively run the validator")
    for argument in (
        f"--config=./{POLICY_RELATIVE_PATH}",
        f"--workflow=./.github/workflows/{name}",
    ):
        if len(re.findall(rf"(?m)^\s+{re.escape(argument)}\s*$", validator_step)) != 1:
            raise PolicyError(f"{name}: validator must be passed {argument}")
    if re.search(r"""(?m)^\s+(?:if|"if"|'if')\s*:""", validator_step):
        raise PolicyError(f"{name}: policy validator step must be unconditional")

    diff_step = _step_block(job, "Scan pull request commits for secrets", name)
    history_step = _step_block(job, "Scan full history for secrets", name)
    if job.index(validator_step) > job.index(diff_step):
        raise PolicyError(f"{name}: policy validator must run before the scanner")
    if not re.search(
        r"(?m)^\s+if: github\.event_name == 'pull_request'$", diff_step
    ):
        raise PolicyError(f"{name}: the diff scan must be scoped to pull requests")
    if not re.search(
        r"(?m)^\s+if: github\.event_name != 'pull_request'$", history_step
    ):
        raise PolicyError(f"{name}: the history scan must cover every non-PR event")
    if not re.search(
        r'--log-opts="--no-merges \$PR_BASE_SHA\.\.\$PR_HEAD_SHA"', diff_step
    ):
        raise PolicyError(f"{name}: the diff scan must cover exactly the PR commits")
    if "--log-opts" in history_step:
        raise PolicyError(f"{name}: the history scan must not be range-limited")

    for step, label in ((diff_step, "diff scan"), (history_step, "history scan")):
        if len(re.findall(rf"--config={re.escape(POLICY_RELATIVE_PATH)}", step)) != 1:
            raise PolicyError(f"{name}: the {label} must load the reviewed policy")
        for forbidden in ("--exit-code", "--baseline-path", "--enable-rule"):
            if forbidden in step:
                raise PolicyError(
                    f"{name}: the {label} must not weaken the gate with {forbidden}"
                )
        if "--redact" not in step:
            raise PolicyError(f"{name}: the {label} must redact its report")
        # Without this flag a `gitleaks:allow` comment on the offending line
        # silently drops the finding. Measured against 8.30.1: a planted Porkbun
        # key with that comment went undetected, and the flag brought it back.
        # That is a suppression channel in ordinary source, reviewable by nobody,
        # so both scans must refuse to honour it.
        if "--ignore-gitleaks-allow" not in step:
            raise PolicyError(
                f"{name}: the {label} must pass --ignore-gitleaks-allow, or a "
                "`gitleaks:allow` comment can suppress a finding unreviewed"
            )


def validate_workflows(workflows: Iterable[Path]) -> None:
    paths = tuple(workflows)
    names = {path.name for path in paths}
    if len(paths) != 1 or names != REQUIRED_WORKFLOWS:
        raise PolicyError(
            f"workflows must be exactly {sorted(REQUIRED_WORKFLOWS)}, got {sorted(names)}"
        )
    for path in paths:
        if not path.is_file():
            raise PolicyError(f"workflow path does not exist: {path}")
        if path.resolve().parent != REPOSITORY_ROOT / ".github" / "workflows":
            raise PolicyError(f"workflow must be under .github/workflows: {path}")
        validate_workflow_text(path.name, path.read_text(encoding="utf-8"))


def validate_policy(
    config: Path,
    workflows: Iterable[Path],
    *,
    today: dt.date | None = None,
) -> None:
    validate_config(config, today=today)
    validate_workflows(workflows)


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument(
        "--workflow", required=True, action="append", type=Path, dest="workflows"
    )
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    try:
        validate_policy(args.config, args.workflows)
    except PolicyError as error:
        print(f"Secret scanning policy validation failed: {error}", file=sys.stderr)
        return 1
    print(
        f"Secret scanning policy valid: {len(APPROVED_RULES)} reviewed rules, "
        f"{len(APPROVED_ALLOWLIST_PATHS)} path-scoped allowlist entries, "
        f"{len(APPROVED_VALUE_ALLOWLIST['regexes'])} value-scoped allowlist entry, "
        f"Gitleaks {GITLEAKS_VERSION} pinned by digest"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
