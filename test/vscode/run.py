"""Exercise a packaged VSIX in a fresh VS Code profile. No npm dependencies."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
FIXTURES = {
    "p4-16": (
        '#include "library.p4i"\ncontrol Ingress(inout Frame frame) { apply { set_mark(frame.tag, 8w7); } }\n',
        'header Frame { bit<8> tag; }\n/// Set packet marker.\n/// @param value New tag.\naction set_mark(inout bit<8> dst, bit<8> value) { dst = value; }\n'
    ),
    "p4-14": (
        '#include "library.p4i"\nheader Tag frame;\naction stamp() { stamp_pair(frame.tag, 17); }\n',
        'header_type Tag { fields { tag : 8; } }\n/// Set packet marker.\n/// @param value New tag.\nprimitive_action stamp_pair(dst, value);\n'
    ),
}

def create_project(project):
    for folder, (program, header) in FIXTURES.items():
        target = project / folder
        target.mkdir(parents=True)
        (target / "main.p4").write_text(program, encoding="utf-8")
        (target / "library.p4i").write_text(header, encoding="utf-8")
    binary = os.environ.get("P4TEST_BINARY")
    config = {}
    if binary:
        (project / "decl.p4").write_text("void takes_bool(in bool x) {}\n", encoding="utf-8")
        (project / "invalid.p4").write_text(
            '#include "decl.p4"\ncontrol Choose(inout bit<8> p) {\n    apply {\n        takes_bool(p);\n    }\n}\n',
            encoding="utf-8")
    elif os.name == "posix":
        binary = project.parent / "p4c-vendor"
        shutil.copyfile(HERE / "fixtures" / "p4c-vendor.py", binary)
        binary.chmod(0o755)
        unit = project / "vendor-main.p4"
        unit.write_text('#include "src/switch.p4"\n', encoding="utf-8")
        config["p4.compiler.entrypoint"] = unit.name
        (project / "src").mkdir()
        prelude = "control Switch() {\n  table example_table_key { actions = { NoAction; } }\n  apply {\n"
        (project / "src" / "switch.p4").write_text(
            prelude + "\n" * (56 - prelude.count("\n")) + "    example_table_key.aply\n    ();\n  }\n}\n",
            encoding="utf-8")
    if binary:
        config.update({"p4.compiler.enabled": True, "p4.compiler.path": str(binary),
                       "p4.compiler.language": "p4-16", "p4.compiler.timeoutMs": 15000})
        settings = project / ".vscode"
        settings.mkdir()
        (settings / "settings.json").write_text(json.dumps(config))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vsix", type=Path)
    parser.add_argument("--code", default="code", help="VS Code or VSCodium desktop CLI")
    parser.add_argument("--container", action="store_true", help="Pass --no-sandbox and --disable-dev-shm-usage in an isolated container")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="p4-host-") as tmp:
        base = Path(tmp)
        project = base / "project"
        create_project(project)
        cmd = [args.code, "--user-data-dir", str(base / "profile"), "--extensions-dir", str(base / "extensions")]
        if args.container:
            cmd.extend(["--no-sandbox", "--disable-dev-shm-usage"])
        env = os.environ.copy()
        for key in ("ELECTRON_RUN_AS_NODE", "VSCODE_IPC_HOOK_CLI", "VSCODE_PORTABLE"):
            env.pop(key, None)
        subprocess.run([*cmd, "--install-extension", str(args.vsix.resolve())], check=True, timeout=90, env=env)
        subprocess.run([*cmd, "--new-window", "--wait", "--disable-gpu", "--disable-workspace-trust",
                        "--skip-welcome", "--skip-release-notes", "--disable-updates",
                        "--extensionDevelopmentPath=" + str(HERE / "driver"),
                        "--extensionTestsPath=" + str(HERE / "suite.js"), str(project)],
                       check=True, timeout=120, env=env)
        result = project / "host-result.json"
        if not result.exists():
            raise SystemExit("Extension Host did not complete its tests; verify desktop IPC and display availability.")
        print(json.dumps(json.loads(result.read_text()), indent=2))

if __name__ == "__main__":
    main()
