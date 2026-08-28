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
REGISTER = ROOT / ".github/RELEASE_SECURITY.md"
WORKFLOW = ROOT / ".github/workflows/security.yml"
TODAY = dt.date(2026, 7, 30)


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

    def _reject_with_register(
        self, policy: str, register: str, expected: str
    ) -> None:
        """Validate against a mutated register, in an isolated tree."""
        original_root = POLICY.REPOSITORY_ROOT
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".github").mkdir()
            (root / ".github/gitleaks.toml").write_text(policy, encoding="utf-8")
            (root / ".github/RELEASE_SECURITY.md").write_text(
                register, encoding="utf-8"
            )
            POLICY.REPOSITORY_ROOT = root
            try:
                with self.assertRaisesRegex(POLICY.PolicyError, expected):
                    POLICY.validate_config(
                        root / ".github/gitleaks.toml", today=TODAY
                    )
            finally:
                POLICY.REPOSITORY_ROOT = original_root

    def test_repository_policy_is_valid(self) -> None:
        POLICY.validate_policy(CONFIG, [WORKFLOW], today=TODAY)

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

    VALUE_ENTRY_MARKER = "# The one value-scoped entry in this policy."

    def test_dropping_the_reviewed_value_allowlist_fails(self) -> None:
        source = CONFIG.read_text(encoding="utf-8")
        self._reject(
            source[: source.index(self.VALUE_ENTRY_MARKER)],
            "exactly one reviewed value-scoped allowlist",
        )

    def test_value_allowlist_may_not_take_a_path_filter(self) -> None:
        """A path filter would skip the whole file in a dir scan, not narrow the entry."""
        source = CONFIG.read_text(encoding="utf-8")
        self._reject(
            source.replace(
                "regexes = [\n    '''^mQINBG",
                "paths = ['''^src-tauri/crates/bc-dns-tools/src/import\\.rs$''']\n"
                "regexes = [\n    '''^mQINBG",
                1,
            ),
            "only suppress by path",
        )

    def test_value_allowlist_may_not_take_a_condition(self) -> None:
        source = CONFIG.read_text(encoding="utf-8")
        self._reject(
            source.replace(
                "regexes = [\n    '''^mQINBG",
                'condition = "AND"\nregexes = [\n    \'\'\'^mQINBG',
                1,
            ),
            "only suppress by path",
        )

    def test_unanchored_value_allowlist_regex_fails(self) -> None:
        source = CONFIG.read_text(encoding="utf-8")
        self._reject(
            source.replace(
                "'''^mQINBGRhbmRvbUtleURhdGFGb3JUZXN0aW5nT25seQ==$'''",
                "'''mQINBGRhbmRvbUtleURhdGFGb3JUZXN0aW5nT25seQ=='''",
                1,
            ),
            "regexes drifted",
        )

    def test_widening_the_reviewed_value_allowlist_fails(self) -> None:
        source = CONFIG.read_text(encoding="utf-8")
        self._reject(
            source.replace(
                "'''^mQINBGRhbmRvbUtleURhdGFGb3JUZXN0aW5nT25seQ==$'''",
                "'''^[A-Za-z0-9+/=]{20,}$'''",
                1,
            ),
            "regexes drifted",
        )

    def test_unreviewed_second_value_allowlist_fails(self) -> None:
        source = CONFIG.read_text(encoding="utf-8")
        self._reject(
            source
            + "\n[[allowlists]]\n"
            'description = "A second value-scoped entry that was never reviewed at all."\n'
            "regexes = ['''^sk1_[a-f0-9]{64}$''']\n",
            "regexes drifted",
        )

    def test_duplicate_reviewed_value_allowlist_fails(self) -> None:
        source = CONFIG.read_text(encoding="utf-8")
        entry = source[source.index(self.VALUE_ENTRY_MARKER) :]
        self._reject(
            source + "\n" + entry,
            "exactly one reviewed value-scoped allowlist",
        )

    def test_path_allowlisting_the_fixture_file_stays_unavailable(self) -> None:
        """The tempting 'simplification' must fail the gate, not merely be discouraged."""
        source = CONFIG.read_text(encoding="utf-8")
        approved = set(POLICY.APPROVED_ALLOWLIST_PATHS)
        try:
            POLICY.APPROVED_ALLOWLIST_PATHS.add(
                "^src-tauri/crates/bc-dns-tools/src/import\\.rs$"
            )
            self._reject(
                source.replace(
                    "'''^out/''',",
                    "'''^out/''',\n    "
                    "'''^src-tauri/crates/bc-dns-tools/src/import\\.rs$''',",
                    1,
                ),
                "would suppress protected files",
            )
        finally:
            POLICY.APPROVED_ALLOWLIST_PATHS.clear()
            POLICY.APPROVED_ALLOWLIST_PATHS.update(approved)

    def test_unreviewed_gitleaksignore_fails_closed(self) -> None:
        """Gitleaks auto-reads a root .gitleaksignore; no scan flag turns it off."""
        original_root = POLICY.REPOSITORY_ROOT
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".github").mkdir()
            (root / ".github/gitleaks.toml").write_text(
                CONFIG.read_text(encoding="utf-8"), encoding="utf-8"
            )
            (root / ".github/RELEASE_SECURITY.md").write_text(
                REGISTER.read_text(encoding="utf-8"), encoding="utf-8"
            )
            POLICY.REPOSITORY_ROOT = root
            try:
                # Comments and blank lines are not a suppression channel.
                (root / ".gitleaksignore").write_text(
                    "# nothing suppressed here\n\n", encoding="utf-8"
                )
                POLICY.validate_config(root / ".github/gitleaks.toml", today=TODAY)

                (root / ".gitleaksignore").write_text(
                    "# but this one suppresses a real finding\n"
                    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef:src/secret.ts:generic-api-key:12\n",
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(
                    POLICY.PolicyError, "unreviewed suppression channel"
                ):
                    POLICY.validate_config(root / ".github/gitleaks.toml", today=TODAY)
            finally:
                POLICY.REPOSITORY_ROOT = original_root

    def test_scans_must_refuse_gitleaks_allow_comments(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertEqual(workflow.count("--ignore-gitleaks-allow"), 2)
        with self.assertRaisesRegex(POLICY.PolicyError, "ignore-gitleaks-allow"):
            POLICY.validate_workflow_text(
                "security.yml",
                workflow.replace("            --ignore-gitleaks-allow \\\n", "", 1),
            )

    def test_prose_mention_does_not_satisfy_the_value_register(self) -> None:
        """Proves the register check is row-scoped, and not vacuous."""
        register = REGISTER.read_text(encoding="utf-8")
        value = POLICY.APPROVED_VALUE_ALLOWLIST["regexes"][0]
        row = next(
            line
            for line in register.splitlines()
            if line.strip().startswith("|") and f"`{value}`" in line
        )
        # Delete the row entirely: the check must FAIL, or it was never testing.
        self._reject_with_register(
            CONFIG.read_text(encoding="utf-8"),
            register.replace(row + "\n", ""),
            "does not table the allowlisted value",
        )
        # Demote the row to prose: still must fail, so a mention cannot stand in.
        self._reject_with_register(
            CONFIG.read_text(encoding="utf-8"),
            register.replace(row, f"The allowlisted value is `{value}` for now."),
            "does not table the allowlisted value",
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
        limited = workflow.replace(
            "            --config=.github/gitleaks.toml \\\n            --redact \\",
            "            --config=.github/gitleaks.toml \\\n"
            '            --log-opts="HEAD~1..HEAD" \\\n'
            "            --redact \\",
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
