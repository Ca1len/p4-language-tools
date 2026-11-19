"""Run the desktop extension in the Node Extension Host of VS Code Server."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
from urllib.parse import urlencode
import xml.etree.ElementTree as ET
from zipfile import ZipFile

from playwright.sync_api import sync_playwright
from run import HERE, create_project


def package_driver(target, archive):
    with ZipFile(target) as release, ZipFile(archive, "w") as driver:
        manifest = ET.fromstring(release.read("extension.vsixmanifest"))
        ns = "{http://schemas.microsoft.com/developer/vsx-schema/2011}"
        identity = manifest.find(ns + "Metadata").find(ns + "Identity")
        identity.attrib.update(Id="check", Publisher="localsmoke", Version="1.0.0")
        driver.writestr("extension.vsixmanifest", ET.tostring(manifest))
        driver.writestr("[Content_Types].xml", release.read("[Content_Types].xml"))
        driver.writestr("extension/package.json", json.dumps({
            "name": "check", "publisher": "localsmoke", "version": "1.0.0",
            "engines": {"vscode": "^1.75.0"}, "main": "./driver.js",
            "activationEvents": ["onStartupFinished"], "extensionKind": ["workspace"],
            "capabilities": {"untrustedWorkspaces": {"supported": True}}
        }))
        driver.write(HERE / "suite.js", "extension/suite.js")
        driver.writestr("extension/driver.js", """
const vscode = require('vscode'), fs = require('node:fs'), path = require('node:path');
exports.activate = async () => {
  try { await require('./suite').run(); }
  catch (error) {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    fs.writeFileSync(path.join(root, 'error.log'), String(error.stack || error));
    throw error;
  }
};
""")


def check_colors(page):
    # Observe actual computed Monaco colours, outside of the provider API.
    # The test runs with a fresh profile and the default theme.
    for _ in range(50):
        colors = page.evaluate("""() => {
          const result = {};
          for (const span of document.querySelectorAll('.monaco-editor .view-line span[class]')) {
            const text = span.textContent.trim();
            if (['Frame','set_mark','tag'].includes(text))
              result[text] = getComputedStyle(span).color;
          }
          return result;
        }""")
        if len(set(colors.values())) == 3:
            return colors
        page.wait_for_timeout(150)
    raise AssertionError("Expected three rendered colours for a type, action and field: " + str(colors))


def check_diagnostic_ui(page):
    problems = page.locator('.markers-panel').get_by_text('syntax error, unexpected IDENTIFIER, expecting APPLY', exact=False)
    problems.first.wait_for(state="visible", timeout=10000)
    page.locator('.monaco-editor .squiggly-error:visible').first.wait_for(timeout=10000)
    file_badge = page.locator('.explorer-folders-view .monaco-list-row').filter(
        has=page.get_by_text("switch.p4", exact=True)).locator('[class*="monaco-decoration-itemBadge"]')
    file_badge.first.wait_for(state="visible", timeout=10000)
    badge = file_badge.first.evaluate("e => getComputedStyle(e, '::after').content")
    assert badge.strip('"') == '1', f"Expected one Explorer problem on switch.p4, got {badge}"
    folder_badge = page.locator('.explorer-folders-view .monaco-list-row').filter(
        has=page.get_by_text("src", exact=True)).locator('[class*="monaco-decoration-bubbleBadge"]')
    folder_badge.first.wait_for(state="visible", timeout=10000)
    bubble = folder_badge.first.evaluate("e => getComputedStyle(e, '::after').content")
    assert bubble.strip('"') not in ('', 'none', 'normal'), "Expected a marker on the parent folder"
    assert not page.locator('.notifications-toasts').get_by_text('P4 compiler:', exact=False).count()
    return {"problemsPanel": True, "editorSquiggle": True, "explorerFileBadge": badge.strip('"'), "folderBadge": True}


def open_related_location(page):
    panel = page.locator('.markers-panel')
    primary = panel.locator('.monaco-list-row').filter(has_text="takes_bool").filter(has_text="type-error").first
    primary.wait_for(state="visible", timeout=10000)
    if primary.get_attribute('aria-expanded') == 'false':
        primary.locator('.monaco-tl-twistie').click()
    link = panel.locator('.monaco-list-row').filter(has_text="Function type 'takes_bool'").first
    link.dblclick(timeout=5000)


def check_compiler_output(page):
    lines = page.locator('.panel .monaco-editor .view-line')
    for message in ('BACKEND layer processing started...', 'Cannot load backend resources'):
        lines.filter(has_text=message).first.wait_for(state="visible", timeout=10000)


def run_browser(url, project, chrome):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=chrome, headless=True,
            args=["--disable-dev-shm-usage", "--disable-gpu"])
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        diagnostics = None
        related = False
        output_checked = False
        for _ in range(120):
            if (project / "error.log").exists():
                raise AssertionError((project / "error.log").read_text())
            if diagnostics is None and (project.parent / "vendor-error-visible").exists():
                diagnostics = check_diagnostic_ui(page)
                (project.parent / "vendor-ui-checked").touch()
            if not related and (project.parent / "compiler-related-ready").exists():
                open_related_location(page)
                related = True
            if not output_checked and (project.parent / "compiler-output-ready").exists():
                check_compiler_output(page)
                (project.parent / "compiler-output-checked").touch()
                output_checked = True
            if (project / "host-result.json").exists():
                report = json.loads((project / "host-result.json").read_text())
                report["editorColors"] = check_colors(page)
                if diagnostics:
                    # The driver has fixed and saved the include at this point.
                    marker = page.locator('.markers-panel').get_by_text('syntax error, unexpected IDENTIFIER, expecting APPLY', exact=False)
                    marker.first.wait_for(state="hidden", timeout=5000)
                    badge = page.locator('.explorer-folders-view .monaco-list-row').filter(
                        has=page.get_by_text('switch.p4', exact=True)).locator('[class*="monaco-decoration-itemBadge"]')
                    badge.first.wait_for(state="hidden", timeout=5000)
                    report["diagnosticUI"] = diagnostics
                if related:
                    report["clickedRelatedLocation"] = True
                if output_checked:
                    report["locationlessFailureInOutput"] = True
                return report
            # Only trust the private fixture directory created by this runner.
            trust = page.get_by_text("Yes, I trust the authors", exact=False)
            if trust.count() and trust.first.is_visible():
                trust.first.click()
            page.wait_for_timeout(500)
        raise TimeoutError("Extension Host did not complete the smoke test")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vsix", type=Path)
    parser.add_argument("--server", required=True, help="Path to the official Microsoft server-linux-x64-web bin/code-server")
    parser.add_argument("--chromium", help="Chromium or chrome-headless-shell executable; default: Playwright's browser")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="p4-hostweb-") as tmp:
        base = Path(tmp)
        project = base / "project"
        create_project(project)
        (base / "inspect-workbench").touch()
        cli = [args.server, "--extensions-dir", str(base / "extensions"), "--user-data-dir", str(base / "user"),
               "--server-data-dir", str(base / "server")]
        driver = base / "driver.vsix"
        package_driver(args.vsix, driver)
        for vsix in [args.vsix, driver]:
            subprocess.run([*cli, "--install-extension", str(vsix.resolve())], check=True, timeout=90)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        token = secrets.token_urlsafe(20)
        with (base / "server.log").open("w") as log:
            process = subprocess.Popen([*cli, "--accept-server-license-terms", "--host", "127.0.0.1", "--port", str(port),
                "--telemetry-level", "off", "--connection-token", token], stdout=log, stderr=subprocess.STDOUT,
                start_new_session=(os.name != 'nt'))
            try:
                for _ in range(100):
                    log.flush()
                    if "Server bound to" in (base / "server.log").read_text():
                        break
                    if process.poll() is not None:
                        raise RuntimeError("VS Code Server exited before accepting connections")
                    time.sleep(.1)
                url = "http://127.0.0.1:" + str(port) + "/?" + urlencode({"tkn": token, "folder": str(project)})
                print(json.dumps(run_browser(url, project, args.chromium), indent=2))
            finally:
                if os.name != 'nt':
                    import signal
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                else:
                    process.terminate()
                process.wait(timeout=15)


if __name__ == "__main__":
    main()
