#!/usr/bin/env python3
"""Deterministic tests for the secret-scanning policy and workflow contract."""

from __future__ import annotations

import datetime as dt
import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("validate-secret-policy.py")
SPEC = importlib.util.spec_from_file_location("validate_secret_policy", SCRIPT)
assert SPEC and SPEC.loader
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)
ROOT = SCRIPT.resolve().parents[2]
CONFIG = ROOT / ".github/gitleaks.toml"
IGNORE = ROOT / ".gitleaksignore"
REGISTER = ROOT / ".github/RELEASE_SECURITY.md"
WORKFLOW = ROOT / ".github/workflows/security.yml"
TODAY = dt.date(2026, 7, 30)

# The reviewed history-scan fingerprint, reused by the tests below.
FIXTURE_FINGERPRINT = (
    "5972d00ab057c78d95c73e55bc36191777b28916"
    ":src-tauri/crates/bc-dns-tools/src/import.rs"
    ":generic-api-key"
    ":1123"
)


class SecretPolicyContractTests(unittest.TestCase):
    def _reject(self, mutated_policy: str, expected: str) -> None:
        """Validate a mutated policy in an isolated tree, never in the repository."""
        original_root = POLICY.REPOSITORY_ROOT
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".github").mkdir()
            (root / ".github/gitleaks.toml").write_text(
                mutated_policy, encoding="utf-8"
            )
            (root / ".github/RELEASE_SECURITY.md").write_text(
                REGISTER.read_text(encoding="utf-8"), encoding="utf-8"
            )
            POLICY.REPOSITORY_ROOT = root
            try:
                with self.assertRaisesRegex(POLICY.PolicyError, expected):
                    POLICY.validate_config(
                        root / ".github/gitleaks.toml", today=TODAY
                    )
            finally:
                POLICY.REPOSITORY_ROOT = original_root

    def _reject_ignore(self, mutated_ignore: str, expected: str) -> None:
        """Validate a mutated ignore file in an isolated tree."""
        original_root = POLICY.REPOSITORY_ROOT
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".gitleaksignore").write_text(mutated_ignore, encoding="utf-8")
            POLICY.REPOSITORY_ROOT = root
            try:
                with self.assertRaisesRegex(POLICY.PolicyError, expected):
                    POLICY._validate_fingerprints(root / ".gitleaksignore")
            finally:
                POLICY.REPOSITORY_ROOT = original_root

    def test_repository_policy_is_valid(self) -> None:
        POLICY.validate_policy(CONFIG, [WORKFLOW], IGNORE, today=TODAY)

    def test_repository_ignore_file_is_exactly_the_reviewed_set(self) -> None:
        self.assertEqual(
            POLICY._validate_fingerprints(IGNORE),
            set(POLICY.APPROVED_FINGERPRINTS),
        )

    def test_ignore_file_must_live_at_the_reviewed_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "gitleaksignore-copy"
            copy.write_text(IGNORE.read_text(encoding="utf-8"), encoding="utf-8")
            with self.assertRaisesRegex(POLICY.PolicyError, "must be exactly"):
                POLICY._validate_fingerprints(copy)

    def test_missing_ignore_file_fails_closed(self) -> None:
        original_root = POLICY.REPOSITORY_ROOT
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            POLICY.REPOSITORY_ROOT = root
            try:
                with self.assertRaisesRegex(POLICY.PolicyError, "does not exist"):
                    POLICY._validate_fingerprints(root / ".gitleaksignore")
            finally:
                POLICY.REPOSITORY_ROOT = original_root

    def test_unapproved_fingerprint_fails(self) -> None:
        source = IGNORE.read_text(encoding="utf-8")
        extra = "0" * 40 + ":src/lib/storage/storage.ts:generic-api-key:12"
        self._reject_ignore(f"{source}{extra}\n", "unapproved fingerprint")

    def test_widened_fingerprint_fails(self) -> None:
        """A suppression may not be broadened into a path or rule wildcard."""
        for widened in (
            "src-tauri/crates/bc-dns-tools/src/import.rs",
            "src-tauri/crates/bc-dns-tools/src/*:generic-api-key:1123",
            "generic-api-key",
            "5972d00:src-tauri/crates/bc-dns-tools/src/import.rs:generic-api-key:1123",
        ):
            with self.subTest(widened=widened):
                self._reject_ignore(f"{widened}\n", "fingerprint")

    def test_dropping_a_reviewed_fingerprint_fails(self) -> None:
        self._reject_ignore("# nothing here\n", "reviewed fingerprints are missing")

    def test_duplicate_fingerprint_fails(self) -> None:
        source = IGNORE.read_text(encoding="utf-8")
        self._reject_ignore(f"{source}{FIXTURE_FINGERPRINT}\n", "duplicate")

    def test_register_must_document_every_fingerprint(self) -> None:
        original_root = POLICY.REPOSITORY_ROOT
        source = REGISTER.read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".github").mkdir()
            (root / ".github/gitleaks.toml").write_text(
                CONFIG.read_text(encoding="utf-8"), encoding="utf-8"
            )
            (root / ".github/RELEASE_SECURITY.md").write_text(
                source.replace(FIXTURE_FINGERPRINT, "undocumented", 1),
                encoding="utf-8",
            )
            POLICY.REPOSITORY_ROOT = root
            try:
                with self.assertRaisesRegex(
                    POLICY.PolicyError, "does not document fingerprint"
                ):
                    POLICY.validate_config(
                        root / ".github/gitleaks.toml", today=TODAY
                    )
            finally:
                POLICY.REPOSITORY_ROOT = original_root

    def test_scans_must_name_the_reviewed_ignore_file(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        stripped = workflow.replace(
            "            --gitleaks-ignore-path=.gitleaksignore \\\n", "", 1
        )
        self.assertNotEqual(stripped, workflow)
        with self.assertRaisesRegex(
            POLICY.PolicyError, "must name the reviewed ignore file"
        ):
            POLICY.validate_workflow_text("security.yml", stripped)

    def test_policy_must_live_at_the_reviewed_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "gitleaks.toml"
            copy.write_text(CONFIG.read_text(encoding="utf-8"), encoding="utf-8")
            with self.assertRaisesRegex(POLICY.PolicyError, "must be exactly"):
                POLICY.validate_config(copy, today=TODAY)

    def test_replacing_the_upstream_ruleset_fails(self) -> None:
        source = CONFIG.read_text(encoding="utf-8")
        self._reject(
            source.replace("useDefault = true", "useDefault = false", 1),
            "extend the upstream ruleset",
        )

    def test_dropping_a_reviewed_rule_fails(self) -> None:
        source = CONFIG.read_text(encoding="utf-8")
        self._reject(
            source.replace('id = "bc-porkbun-api-key"', 'id = "bc-unreviewed"', 1),
            "unapproved or missing rule id",
        )

    def test_blanket_test_directory_allowlist_fails(self) -> None:
        source = CONFIG.read_text(encoding="utf-8")
        self._reject(
            source.replace("'''^out/''',", "'''^out/''',\n    '''^test/''',", 1),
            "unapproved allowlist path",
        )

    def test_value_shaped_global_allowlist_fails(self) -> None:
        source = CONFIG.read_text(encoding="utf-8")
        self._reject(
            source.replace(
                "paths = [\n    '''^package-lock\\.json$''',",
                "regexes = ['''.*''']\npaths = [\n    '''^package-lock\\.json$''',",
                1,
            ),
            "only suppress by path",
        )

    def test_broad_path_that_hides_real_source_fails(self) -> None:
        source = CONFIG.read_text(encoding="utf-8")
        approved = set(POLICY.APPROVED_ALLOWLIST_PATHS)
        try:
            POLICY.APPROVED_ALLOWLIST_PATHS.add("^src/")
            self._reject(
                source.replace("'''^out/''',", "'''^out/''',\n    '''^src/''',", 1),
                "would suppress protected files",
            )
        finally:
            POLICY.APPROVED_ALLOWLIST_PATHS.clear()
            POLICY.APPROVED_ALLOWLIST_PATHS.update(approved)

    def test_expired_review_fails(self) -> None:
        expired = POLICY.POLICY_REVIEW_DEADLINE + dt.timedelta(days=1)
        with self.assertRaisesRegex(POLICY.PolicyError, "review expired"):
            POLICY.validate_config(CONFIG, today=expired)

    def test_unpinned_scanner_fails(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        with self.assertRaisesRegex(POLICY.PolicyError, "digest pin"):
            POLICY.validate_workflow_text(
                "security.yml",
                workflow.replace(POLICY.GITLEAKS_SHA256, "0" * 64, 1),
            )
        with self.assertRaisesRegex(POLICY.PolicyError, "version pin"):
            POLICY.validate_workflow_text(
                "security.yml",
                workflow.replace(
                    f"GITLEAKS_VERSION: {POLICY.GITLEAKS_VERSION}",
                    "GITLEAKS_VERSION: latest",
                    1,
                ),
            )

    def test_softening_the_gate_fails(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        for mutation in (
            "--exit-code=0 \\\n            --redact \\",
            "--baseline-path=baseline.json \\\n            --redact \\",
        ):
            with self.assertRaisesRegex(
                POLICY.PolicyError, "must not weaken the gate"
            ):
                POLICY.validate_workflow_text(
                    "security.yml", workflow.replace("--redact \\", mutation, 1)
                )

    def test_conditional_validator_fails(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        disabled = workflow.replace(
            "      - name: Validate fail-closed secret scanning policy\n",
            "      - name: Validate fail-closed secret scanning policy\n"
            "        if: false\n",
            1,
        )
        with self.assertRaisesRegex(POLICY.PolicyError, "must be unconditional"):
            POLICY.validate_workflow_text("security.yml", disabled)

    def test_continue_on_error_is_forbidden(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        with self.assertRaisesRegex(POLICY.PolicyError, "continue-on-error"):
            POLICY.validate_workflow_text(
                "security.yml",
                workflow.replace(
                    "    timeout-minutes: 15\n",
                    "    timeout-minutes: 15\n    continue-on-error: true\n",
                    1,
                ),
            )

    def test_pull_request_scan_must_stay_range_limited(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        with self.assertRaisesRegex(POLICY.PolicyError, "exactly the PR commits"):
            POLICY.validate_workflow_text(
                "security.yml",
                workflow.replace(
                    '--log-opts="--no-merges $PR_BASE_SHA..$PR_HEAD_SHA"',
                    '--log-opts="--all"',
                    1,
                ),
            )

    def test_history_scan_must_not_be_range_limited(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        anchor = (
            "            --config=.github/gitleaks.toml \\\n"
            "            --gitleaks-ignore-path=.gitleaksignore \\\n"
            "            --redact \\"
        )
        limited = workflow.replace(
            anchor,
            anchor.replace(
                "            --redact \\",
                '            --log-opts="HEAD~1..HEAD" \\\n            --redact \\',
            ),
            1,
        )
        self.assertNotEqual(limited, workflow)
        with self.assertRaisesRegex(POLICY.PolicyError, "must not be range-limited"):
            POLICY.validate_workflow_text("security.yml", limited)

    def test_workflow_set_must_be_exact(self) -> None:
        with self.assertRaisesRegex(POLICY.PolicyError, "workflows must be exactly"):
            POLICY.validate_workflows([WORKFLOW, ROOT / ".github/workflows/ci.yml"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
