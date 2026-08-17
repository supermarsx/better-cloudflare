#!/usr/bin/env python3
"""Deterministic tests for the OSV policy and workflow contract."""

from __future__ import annotations

import datetime as dt
import importlib.util
import tempfile
import tomllib
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("validate-osv-policy.py")
SPEC = importlib.util.spec_from_file_location("validate_osv_policy", SCRIPT)
assert SPEC and SPEC.loader
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)
ROOT = SCRIPT.resolve().parents[2]

# Advisories retired by the tauri-plugin 2.6.3 upgrade, which moved tauri-utils
# onto the "build-2" (dom_query) HTML backend and removed the archived
# kuchikiki -> selectors -> phf_generator stack from the lockfile. They must stay
# retired: the packages they name are gone, so re-listing either one would make
# the validator fail closed as a stale exception.
RETIRED_EXCEPTIONS = {
    "RUSTSEC-2025-0057": ("fxhash", "0.2.1"),
    "RUSTSEC-2026-0097": ("rand", "0.7.3"),
}


def _resolved_packages() -> set[tuple[str, str]]:
    lock = tomllib.loads((ROOT / "Cargo.lock").read_text(encoding="utf-8"))
    return {(entry["name"], entry["version"]) for entry in lock["package"]}


def _synthetic_lock(
    directory: Path,
    *,
    drop: set[tuple[str, str]] | None = None,
    downgrade: tuple[str, str] | None = None,
) -> Path:
    """Write a name/version-only Cargo.lock so resolution can be mutated safely."""
    lock = tomllib.loads((ROOT / "Cargo.lock").read_text(encoding="utf-8"))
    lines = ["version = 4", ""]
    for entry in lock["package"]:
        name, version = entry["name"], entry["version"]
        if drop and (name, version) in drop:
            continue
        if downgrade and name == downgrade[0]:
            version = downgrade[1]
        lines += ["[[package]]", f'name = "{name}"', f'version = "{version}"', ""]
    path = directory / "Cargo.lock"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def _config_without(advisory_id: str) -> str:
    source = (ROOT / "osv-scanner.toml").read_text(encoding="utf-8")
    blocks = source.split("[[IgnoredVulns]]\n")
    kept = [block for block in blocks[1:] if f'id = "{advisory_id}"\n' not in block]
    assert len(kept) == len(blocks) - 2, f"{advisory_id} is not in the config"
    return "".join(f"[[IgnoredVulns]]\n{block}" for block in kept)


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

    def test_stale_exception_fails(self) -> None:
        """An exception naming an absent package must be removed, not tolerated."""
        with tempfile.TemporaryDirectory() as directory:
            lockfile = _synthetic_lock(Path(directory), drop={("atk", "0.18.2")})
            with self.assertRaisesRegex(
                POLICY.PolicyError, r"stale exception, atk@0\.18\.2 is absent"
            ):
                POLICY.validate_config(
                    ROOT / "osv-scanner.toml", lockfile, today=dt.date(2026, 7, 30)
                )

    def test_retired_exceptions_are_not_reintroduced(self) -> None:
        config = (ROOT / "osv-scanner.toml").read_text(encoding="utf-8")
        register = (ROOT / ".github/RELEASE_SECURITY.md").read_text(encoding="utf-8")
        resolved = _resolved_packages()
        for advisory_id, package in RETIRED_EXCEPTIONS.items():
            with self.subTest(advisory=advisory_id):
                self.assertNotIn(advisory_id, POLICY.APPROVED_EXCEPTIONS)
                self.assertNotIn(advisory_id, POLICY.APPROVED_JUSTIFICATIONS)
                self.assertNotIn(advisory_id, config)
                self.assertNotIn(f"| `{advisory_id}` |", register)
                self.assertNotIn(package, resolved)

    def test_approved_tables_stay_in_lockstep(self) -> None:
        self.assertEqual(
            set(POLICY.APPROVED_EXCEPTIONS), set(POLICY.APPROVED_JUSTIFICATIONS)
        )

    def test_dropping_a_live_exception_fails(self) -> None:
        """The ID set is exact in both directions, so silent removal fails too."""
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "osv-scanner.toml"
            config.write_text(_config_without("RUSTSEC-2024-0413"), encoding="utf-8")
            old_root = POLICY.REPOSITORY_ROOT
            POLICY.REPOSITORY_ROOT = Path(directory)
            try:
                with self.assertRaisesRegex(
                    POLICY.PolicyError,
                    r"policy ID set drifted: missing=\['RUSTSEC-2024-0413'\]",
                ):
                    POLICY.validate_config(
                        config, ROOT / "Cargo.lock", today=dt.date(2026, 7, 30)
                    )
            finally:
                POLICY.REPOSITORY_ROOT = old_root

    def test_security_floor_regression_fails(self) -> None:
        """Downgrading tauri-plugin would resurrect the retired advisories."""
        with tempfile.TemporaryDirectory() as directory:
            lockfile = _synthetic_lock(
                Path(directory), downgrade=("tauri-plugin", "2.5.2")
            )
            with self.assertRaisesRegex(
                POLICY.PolicyError,
                r"tauri-plugin resolved below security floor 2\.6\.3",
            ):
                POLICY.validate_config(
                    ROOT / "osv-scanner.toml", lockfile, today=dt.date(2026, 7, 30)
                )

    def test_required_package_absence_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lockfile = _synthetic_lock(Path(directory), drop={("tauri-plugin", "2.6.3")})
            with self.assertRaisesRegex(
                POLICY.PolicyError, r"required package is absent: tauri-plugin"
            ):
                POLICY.validate_config(
                    ROOT / "osv-scanner.toml", lockfile, today=dt.date(2026, 7, 30)
                )

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

    def test_commented_scanner_argument_does_not_count(self) -> None:
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        argument = "--lockfile=./Cargo.lock"
        scanner_position = workflow.index(POLICY.OSV_IMAGE)
        weakened = (
            workflow[:scanner_position]
            + workflow[scanner_position:].replace(
                f"            {argument}", f"        # {argument}", 1
            )
        )
        with self.assertRaisesRegex(POLICY.PolicyError, "scanner step must pass"):
            POLICY.validate_workflow_text("ci.yml", weakened)

    def test_reviewed_reason_metadata_cannot_drift(self) -> None:
        source = (ROOT / "osv-scanner.toml").read_text(encoding="utf-8")
        mutations = {
            "owner": (
                "owner=Better Cloudflare security maintainers",
                "owner=Unrelated arbitrary owner",
            ),
            "review": (
                "review=.github/RELEASE_SECURITY.md#osv-exception-register",
                "review=https://attacker.invalid/review/2099-01-01",
            ),
            "rationale": (
                "rationale=GTK3 bindings are archived and have no patched GTK3 "
                "release, while GTK4 requires an upstream Tauri runtime migration",
                "rationale=generic placeholder rationale",
            ),
            "reachability": (
                "reachability=transitive through Tauri 2.11.1 GTK3 runtime",
                "reachability=transitive through imaginary package",
            ),
        }
        for field, (before, after) in mutations.items():
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                config = Path(directory) / "osv-scanner.toml"
                config.write_text(source.replace(before, after, 1), encoding="utf-8")
                old_root = POLICY.REPOSITORY_ROOT
                POLICY.REPOSITORY_ROOT = Path(directory)
                try:
                    with self.assertRaisesRegex(
                        POLICY.PolicyError, "reviewed reason metadata drifted"
                    ):
                        POLICY.validate_config(
                            config, ROOT / "Cargo.lock", today=dt.date(2026, 7, 30)
                        )
                finally:
                    POLICY.REPOSITORY_ROOT = old_root

    def test_critical_workflow_steps_cannot_be_conditional(self) -> None:
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        scanner = f"uses: {POLICY.OSV_IMAGE}"
        scanner_disabled = workflow.replace(
            scanner, f"if: false\n        {scanner}", 1
        )
        with self.assertRaisesRegex(POLICY.PolicyError, "must be unconditional"):
            POLICY.validate_workflow_text("ci.yml", scanner_disabled)

        validator = (
            "run: >-\n"
            "          python3 .github/scripts/validate-osv-policy.py"
        )
        validator_disabled = workflow.replace(
            validator, f"if: false\n        {validator}", 1
        )
        with self.assertRaisesRegex(POLICY.PolicyError, "must be unconditional"):
            POLICY.validate_workflow_text("ci.yml", validator_disabled)

        quoted_if = workflow.replace(
            scanner,
            f'"if": github.event_name == \'push\'\n        {scanner}',
            1,
        )
        with self.assertRaisesRegex(POLICY.PolicyError, "must be unconditional"):
            POLICY.validate_workflow_text("ci.yml", quoted_if)

    def test_scanner_image_must_be_an_active_uses_value(self) -> None:
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        active = f"uses: {POLICY.OSV_IMAGE}"
        bypass = workflow.replace(
            active,
            "uses: actions/checkout@"
            "3d3c42e5aac5ba805825da76410c181273ba90b1\n"
            f"        # {active}",
            1,
        )
        with self.assertRaisesRegex(POLICY.PolicyError, "actively use"):
            POLICY.validate_workflow_text("ci.yml", bypass)

    def test_validator_command_must_be_active(self) -> None:
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        command = "python3 .github/scripts/validate-osv-policy.py"
        bypass = workflow.replace(command, f"true\n          # {command}", 1)
        with self.assertRaisesRegex(POLICY.PolicyError, "actively run"):
            POLICY.validate_workflow_text("ci.yml", bypass)

    def test_osv_job_condition_cannot_drift(self) -> None:
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        ci_disabled = ci.replace(
            "  release_contract:\n",
            "  release_contract:\n    if: false\n",
            1,
        )
        with self.assertRaisesRegex(POLICY.PolicyError, "job condition drifted"):
            POLICY.validate_workflow_text("ci.yml", ci_disabled)

        security = (ROOT / ".github/workflows/security.yml").read_text(
            encoding="utf-8"
        )
        security_disabled = security.replace(
            "if: github.event_name != 'pull_request'", "if: false", 1
        )
        with self.assertRaisesRegex(POLICY.PolicyError, "job condition drifted"):
            POLICY.validate_workflow_text("security.yml", security_disabled)

    def test_continue_on_error_is_forbidden(self) -> None:
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        with self.assertRaisesRegex(POLICY.PolicyError, "continue-on-error"):
            POLICY.validate_workflow_text(
                "ci.yml", workflow + "\n      continue-on-error: true\n"
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
