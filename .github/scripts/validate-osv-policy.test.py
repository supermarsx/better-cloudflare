#!/usr/bin/env python3
"""Deterministic tests for the OSV policy and workflow contract."""

from __future__ import annotations

import datetime as dt
import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("validate-osv-policy.py")
SPEC = importlib.util.spec_from_file_location("validate_osv_policy", SCRIPT)
assert SPEC and SPEC.loader
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)
ROOT = SCRIPT.resolve().parents[2]


class OsvPolicyContractTests(unittest.TestCase):
    def test_repository_policy_is_valid(self) -> None:
        POLICY.validate_policy(
            ROOT / "osv-scanner.toml",
            [ROOT / "package-lock.json", ROOT / "Cargo.lock"],
            [ROOT / ".github/workflows/ci.yml", ROOT / ".github/workflows/security.yml"],
            today=dt.date(2026, 7, 30),
        )

    def test_expired_ignore_fails(self) -> None:
        source = (ROOT / "osv-scanner.toml").read_text(encoding="utf-8")
        expired = source.replace("2026-10-30", "2026-01-01", 1)
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "osv-scanner.toml"
            config.write_text(expired, encoding="utf-8")
            with self.assertRaisesRegex(POLICY.PolicyError, "repository root"):
                POLICY.validate_config(
                    config, ROOT / "Cargo.lock", today=dt.date(2026, 7, 30)
                )
            # Parse/expiry behavior is exercised without weakening the root-path
            # invariant by temporarily overriding the module's expected root.
            old_root = POLICY.REPOSITORY_ROOT
            POLICY.REPOSITORY_ROOT = Path(directory)
            try:
                with self.assertRaisesRegex(POLICY.PolicyError, "ignore expired"):
                    POLICY.validate_config(
                        config, ROOT / "Cargo.lock", today=dt.date(2026, 7, 30)
                    )
            finally:
                POLICY.REPOSITORY_ROOT = old_root

    def test_missing_config_path_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            old_root = POLICY.REPOSITORY_ROOT
            POLICY.REPOSITORY_ROOT = Path(directory)
            try:
                with self.assertRaisesRegex(POLICY.PolicyError, "does not exist"):
                    POLICY.validate_config(
                        Path(directory) / "osv-scanner.toml",
                        ROOT / "Cargo.lock",
                        today=dt.date(2026, 7, 30),
                    )
            finally:
                POLICY.REPOSITORY_ROOT = old_root

    def test_synthetic_new_vulnerability_fails(self) -> None:
        finding = {
            "ids": ["OSV-SYNTHETIC-NEW-VULNERABILITY"],
            "reachable_fixed_versions": ["9.9.9"],
        }
        with self.assertRaisesRegex(POLICY.PolicyError, "unlisted advisory"):
            POLICY.validate_findings(set(POLICY.APPROVED_EXCEPTIONS), [finding])

    def test_unlisted_informational_advisory_fails(self) -> None:
        finding = {"ids": ["RUSTSEC-2099-0001"], "reachable_fixed_versions": []}
        with self.assertRaisesRegex(POLICY.PolicyError, "unlisted advisory"):
            POLICY.validate_findings(set(POLICY.APPROVED_EXCEPTIONS), [finding])

    def test_fixable_advisory_cannot_be_ignored(self) -> None:
        finding = {
            "ids": ["GHSA-7gmj-67g7-phm9"],
            "reachable_fixed_versions": ["2.11.1"],
        }
        with self.assertRaisesRegex(POLICY.PolicyError, "fixable advisory"):
            POLICY.validate_findings({"GHSA-7gmj-67g7-phm9"}, [finding])

    def test_fixable_id_cannot_enter_config(self) -> None:
        source = (ROOT / "osv-scanner.toml").read_text(encoding="utf-8")
        weakened = source.replace(
            "RUSTSEC-2024-0413", "GHSA-7gmj-67g7-phm9", 1
        )
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "osv-scanner.toml"
            config.write_text(weakened, encoding="utf-8")
            old_root = POLICY.REPOSITORY_ROOT
            POLICY.REPOSITORY_ROOT = Path(directory)
            try:
                with self.assertRaisesRegex(POLICY.PolicyError, "fixable advisory"):
                    POLICY.validate_config(
                        config, ROOT / "Cargo.lock", today=dt.date(2026, 7, 30)
                    )
            finally:
                POLICY.REPOSITORY_ROOT = old_root

    def test_workflow_missing_config_argument_fails(self) -> None:
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        weakened = workflow.replace("--config=./osv-scanner.toml", "", 1)
        with self.assertRaisesRegex(POLICY.PolicyError, "must pass"):
            POLICY.validate_workflow_text("ci.yml", weakened)

    def test_continue_on_error_is_forbidden(self) -> None:
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        with self.assertRaisesRegex(POLICY.PolicyError, "continue-on-error"):
            POLICY.validate_workflow_text(
                "ci.yml", workflow + "\n      continue-on-error: true\n"
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
