"""Exercise server playback and history import in the built desktop app.

Requires Python Playwright. Run npm run build first.
"""
import io
import json
import math
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
import wave

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
(ROOT / 'tmp').mkdir(exist_ok=True)
WORK = Path(tempfile.mkdtemp(prefix='community-ui-', dir=ROOT / 'tmp'))
MEDIA = WORK / 'media'
PROFILE = WORK / 'profile'
MEDIA.mkdir()
PROFILE.mkdir()
wav = io.BytesIO()
with wave.open(wav, 'wb') as writer:
    writer.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
    writer.writeframes(b''.join(struct.pack('<h', int(3000 * math.sin(i * 2 * math.pi * 440 / 44100))) for i in range(44100 * 12)))
AUDIO = wav.getvalue()
LOCAL_TRACK = MEDIA / 'Library history fixture.wav'
LOCAL_TRACK.write_bytes(AUDIO)
HISTORY = WORK / 'history.json'
HISTORY.write_text(json.dumps([
    {'path': str(LOCAL_TRACK), 'played_at': '2025-01-01T12:00:00Z'},
    {'path': str(LOCAL_TRACK), 'played_at': '2025-01-02T12:00:00Z'},
]), encoding='utf-8')
(PROFILE / 'settings.json').write_text(json.dumps({
    'libraryRoots': [str(MEDIA)], 'libraryAutoWatch': False,
    'firstLaunchTutorialSeen': True, 'volume': 0, 'closeButtonBehavior': 'close-app',
}), encoding='utf-8')
REQUESTS = []


def wait_until(page, expression, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if page.evaluate(expression):
            return
        time.sleep(0.1)
    page.screenshot(path=str(WORK / 'failure.png'))
    raise AssertionError(f'Timed out: {expression}')


class Server(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        assert payload == {'Username': 'tester', 'Pw': 'fixture-password'}
        self.respond({'AccessToken': 'fixture-jellyfin-token', 'User': {'Id': 'user-one'}, 'ServerId': 'server-one'})

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query, keep_blank_values=True)
        REQUESTS.append({'path': url.path, 'range': self.headers.get('Range')})
        if url.path.endswith('/System/Info') or url.path.endswith('/System/Info/Public'):
            return self.respond({'ServerName': 'Fixture Jellyfin', 'Version': '10.11.0', 'Id': 'server-one'})
        if url.path.endswith('/ping.view'):
            return self.respond({'subsonic-response': {'status': 'ok', 'version': '1.16.1', 'type': 'navidrome', 'serverVersion': 'fixture'}})
        if '/Audio/' in url.path or url.path.endswith('/stream.view'):
            start, end, status = 0, len(AUDIO) - 1, 200
            byte_range = self.headers.get('Range')
            if byte_range:
                match = re.fullmatch(r'bytes=(\d+)-(\d*)', byte_range)
                assert match, byte_range
                start = int(match[1])
                end = min(int(match[2]) if match[2] else end, end)
                status = 206
            if start > end:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{len(AUDIO)}')
                self.end_headers()
                return
            self.send_response(status)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(end - start + 1))
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{len(AUDIO)}')
            self.end_headers()
            try:
                self.wfile.write(AUDIO[start:end + 1])
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        is_jellyfin = url.path.endswith('/Items')
        if is_jellyfin or url.path.endswith('/search3.view'):
            search = query.get('searchTerm' if is_jellyfin else 'query', [''])[0]
            count = 1 if search else 101
            offset = int(query.get('startIndex' if is_jellyfin else 'songOffset', [0])[0])
            limit = int(query.get('limit' if is_jellyfin else 'songCount', [100])[0])
            songs = []
            for i in range(offset, min(count, offset + limit)):
                title = 'Needle song' if search else f'Server fixture {i + 1:03}'
                if is_jellyfin:
                    songs.append({'Id': f'song-{i}', 'Name': title, 'Artists': ['Fixture Artist'], 'Album': 'Fixture Album', 'Container': 'wav', 'RunTimeTicks': 120000000, 'MediaSources': [{'Container': 'wav', 'Size': len(AUDIO), 'MediaStreams': [{'Type': 'Audio', 'SampleRate': 44100}]}]})
                else:
                    songs.append({'id': f'song-{i}', 'title': title, 'artist': 'Fixture Artist', 'album': 'Fixture Album', 'suffix': 'wav', 'contentType': 'audio/wav', 'duration': 12, 'size': len(AUDIO), 'samplingRate': 44100})
            if is_jellyfin:
                return self.respond({'Items': songs, 'TotalRecordCount': count})
            return self.respond({'subsonic-response': {'status': 'ok', 'version': '1.16.1', 'searchResult3': {'song': songs}}})
        self.respond({'error': 'Unexpected fixture endpoint'}, 404)


server = ThreadingHTTPServer(('127.0.0.1', 0), Server)
threading.Thread(target=server.serve_forever, daemon=True).start()
wrapper = WORK / 'main.mjs'
wrapper.write_text("import { app, dialog } from 'electron';\n"
                   "app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');\n"
                   "dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [" + json.dumps(str(HISTORY)) + "] });\n"
                   "await import(" + json.dumps((ROOT / 'dist-electron/electron/main.js').as_uri()) + ");\n", encoding='utf-8')
(WORK / 'package.json').write_text(json.dumps({'name': 'newamp', 'version': json.loads((ROOT / 'package.json').read_text())['version'], 'type': 'module', 'main': 'main.mjs'}), encoding='utf-8')
electron_name = (ROOT / 'node_modules/electron/path.txt').read_text().strip()
electron = ROOT / 'node_modules/electron/dist' / electron_name
env = {**os.environ, 'NEWAMP_USER_DATA_DIR': str(PROFILE), 'NEWAMP_SESSION_DATA_DIR': str(WORK / 'session'), 'NEWAMP_DISABLE_HARDWARE_ACCELERATION': '1', 'NODE_ENV': 'production'}
env.pop('ELECTRON_RUN_AS_NODE', None)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    debug_port = sock.getsockname()[1]
log = (WORK / 'electron.log').open('w', encoding='utf-8')
process = subprocess.Popen([str(electron), str(WORK), f'--remote-debugging-port={debug_port}'], cwd=ROOT, env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
try:
    with sync_playwright() as playwright:
        browser = None
        for _ in range(60):
            if process.poll() is not None:
                raise RuntimeError(f'Electron exited {process.returncode}; see {WORK / "electron.log"}')
            try:
                browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{debug_port}', timeout=1000)
                break
            except Exception:
                time.sleep(0.25)
        assert browser, 'Electron debugging endpoint never appeared'
        page = None
        for _ in range(100):
            candidates = [p for context in browser.contexts for p in context.pages if 'index.html' in p.url or 'newamp-app' in p.url]
            if candidates:
                page = candidates[-1]
                break
            time.sleep(0.1)
        assert page, 'NewAmp did not create its renderer window'
        page.wait_for_load_state('networkidle')
        wait_until(page, '() => !!window.newamp')
        page.goto(page.url + ('&' if '?' in page.url else '?') + 'newamp-smoke=1')
        page.wait_for_load_state('networkidle')
        page.evaluate('(roots) => window.newamp.scanLibrary(roots)', [str(MEDIA)])
        wait_until(page, 'async () => await window.newamp.getTrackCount() === 1')
        page.get_by_role('button', name='History', exact=True).click()
        page.get_by_text('Import listening history', exact=True).click()
        page.get_by_role('button', name='Import CSV or JSON', exact=True).click()
        expect(page.get_by_text(re.compile(r'^2 imported · 0 duplicates'))).to_be_visible()
        page.get_by_role('button', name='Import CSV or JSON', exact=True).click()
        expect(page.get_by_text(re.compile(r'^0 imported · 2 duplicates'))).to_be_visible()
        assert page.evaluate('async () => (await window.newamp.getListeningInsights()).total.plays') == 2
        page.screenshot(path=str(WORK / 'history-import.png'))
        page.get_by_role('button', name='Music Servers', exact=True).click()
        page.wait_for_selector('form')
        for provider, subpath in [('jellyfin', 'jellyfin'), ('subsonic', 'navidrome')]:
            page.locator('details').evaluate('(el) => { el.open = true; }')
            page.get_by_label('Server type', exact=True).select_option(provider)
            page.get_by_label('Server URL', exact=True).fill(f'http://127.0.0.1:{server.server_port}/{subpath}')
            page.get_by_label('Username', exact=True).fill('tester')
            page.get_by_label('Password', exact=True).fill('fixture-password')
            page.get_by_label('Remember connection', exact=True).uncheck()
            page.get_by_role('button', name='Connect', exact=True).click()
            expect(page.get_by_role('button', name='Play Server fixture 001', exact=True)).to_be_visible()
            page.get_by_role('button', name='Next page', exact=True).click()
            expect(page.get_by_role('button', name='Play Server fixture 101', exact=True)).to_be_visible()
            page.get_by_label('Search server music', exact=True).fill('needle')
            page.get_by_role('button', name='Search', exact=True).click()
            expect(page.get_by_role('button', name='Play Needle song', exact=True)).to_be_visible()
            page.get_by_role('button', name='Play Needle song', exact=True).click()
            wait_until(page, '() => window.__newampSmoke.engineCurrentTime() > 0.3')
            page.locator('[data-newamp-scrub]').evaluate("el => { el.value = '6'; el.dispatchEvent(new Event('input', { bubbles: true })); }")
            wait_until(page, '() => window.__newampSmoke.engineCurrentTime() >= 6')
            assert page.evaluate('window.__newampSmoke.analyserFftSum()') > 0, 'Server audio must reach visualizer analyser'
            saved = page.evaluate('() => window.newamp.getMusicServers()')
            assert 'fixture-password' not in json.dumps(saved) and 'fixture-jellyfin-token' not in json.dumps(saved)
            connection = saved[-1]
            track = page.evaluate('(id) => window.newamp.getMusicServerTracks(id, {limit: 1})', connection['id'])['tracks'][0]
            assert track['id'] < 0 and track['path'].startswith('newamp://server/')
            range_result = page.evaluate("async path => { const r = await fetch(path, {headers: {Range: 'bytes=44-53'}}); return {status: r.status, range: r.headers.get('Content-Range'), bytes: Array.from(new Uint8Array(await r.arrayBuffer()))}; }", track['path'])
            assert range_result == {'status': 206, 'range': f'bytes 44-53/{len(AUDIO)}', 'bytes': list(AUDIO[44:54])}, range_result
            page.screenshot(path=str(WORK / f'{provider}-playback.png'))
        assert not (PROFILE / 'music-servers.json').exists(), 'Session-only credentials reached disk'
        resume_verified = False
        if os.name == 'nt':
            page.locator('details').evaluate('(el) => { el.open = true; }')
            page.get_by_label('Password', exact=True).fill('fixture-password')
            page.get_by_label('Remember connection', exact=True).check()
            page.get_by_role('button', name='Connect', exact=True).click()
            expect(page.get_by_role('button', name='Play Server fixture 001', exact=True)).to_be_visible()
            page.get_by_role('button', name='Play Server fixture 001', exact=True).click()
            wait_until(page, '() => window.__newampSmoke.engineCurrentTime() > 0.3')
            page.locator('[data-newamp-scrub]').evaluate("el => { el.value = '6'; el.dispatchEvent(new Event('input', { bubbles: true })); }")
            wait_until(page, '() => window.__newampSmoke.engineCurrentTime() >= 6')
            page.locator('[data-newamp-transport]').get_by_role('button', name='Pause', exact=True).click()
            wait_until(page, 'async () => { const s = (await window.newamp.getSettings()).resumeState; return s?.currentTrackId < 0 && s.currentTime >= 6; }')
            page.evaluate('() => window.newamp.setSettings({ volume: 0 })')
            encrypted = (PROFILE / 'music-servers.json').read_text()
            assert 'fixture-password' not in encrypted and 'fixture-jellyfin-token' not in encrypted
            page.reload()
            page.wait_for_load_state('networkidle')
            expect(page.locator('[data-newamp-current-title]')).to_have_attribute('data-newamp-current-title', 'Fixture Artist - Server fixture 001')
            expect(page.locator('[data-newamp-transport]')).to_have_attribute('data-newamp-playing', 'false')
            page.locator('[data-newamp-transport]').get_by_role('button', name='Play', exact=True).click()
            wait_until(page, '() => window.__newampSmoke.engineCurrentTime() >= 6')
            resume_verified = True
        print(json.dumps({'ok': True, 'historyImported': 2, 'reimportDuplicates': 2, 'providers': ['jellyfin', 'subsonic'], 'playbackAndSeek': True, 'visualizerAnalyser': True, 'byteRangeExact': True, 'encryptedCredentialsAndQueueReload': resume_verified, 'artifacts': str(WORK)}, indent=2))
        browser.close()
except Exception:
    if 'page' in globals() and page:
        try:
            page.screenshot(path=str(WORK / 'failure.png'))
            (WORK / 'failure.html').write_text(page.content(), encoding='utf-8')
        except Exception:
            pass
    print(f'Failure artifacts: {WORK}', flush=True)
    raise
finally:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
    server.shutdown()
    log.close()
