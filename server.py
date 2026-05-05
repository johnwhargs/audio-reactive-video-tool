import os
import uuid
import subprocess
import threading
import time
import re
import json
from flask import Flask, request, jsonify, Response, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, 'uploads')
PROCESSED_DIR = os.path.join(BASE_DIR, 'processed')

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(PROCESSED_DIR, exist_ok=True)

app = Flask(__name__, static_folder='static', static_url_path='')
app.config['MAX_CONTENT_LENGTH'] = 2 * 1024 * 1024 * 1024  # 2GB

# In-memory job tracking (single-user local tool)
jobs = {}


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/preprocess', methods=['POST'])
def preprocess():
    if 'file' not in request.files:
        return jsonify({'error': 'no file'}), 400
    f = request.files['file']
    if not f.filename:
        return jsonify({'error': 'empty filename'}), 400

    job_id = uuid.uuid4().hex[:12]
    ext = os.path.splitext(f.filename)[1] or '.mp4'
    input_path = os.path.join(UPLOAD_DIR, f'{job_id}_input{ext}')
    output_path = os.path.join(PROCESSED_DIR, f'{job_id}_cleaned.mp4')

    f.save(input_path)

    jobs[job_id] = {
        'status': 'processing',
        'progress': 0,
        'duration': None,
        'error': None,
        'input': input_path,
        'output': output_path,
    }

    thread = threading.Thread(target=run_ffmpeg, args=(job_id, input_path, output_path))
    thread.start()

    return jsonify({'job_id': job_id})


def parse_duration(s):
    """Parse HH:MM:SS.xx to seconds."""
    m = re.search(r'Duration:\s*(\d+):(\d+):(\d+)\.(\d+)', s)
    if m:
        return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) + int(m[4]) / 100
    return None


def parse_time(s):
    """Parse time=HH:MM:SS.xx from ffmpeg progress line."""
    m = re.search(r'time=(\d+):(\d+):(\d+)\.(\d+)', s)
    if m:
        return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) + int(m[4]) / 100
    return None


def run_ffmpeg(job_id, input_path, output_path):
    job = jobs[job_id]
    try:
        proc = subprocess.Popen(
            [
                'ffmpeg', '-y', '-i', input_path,
                '-vf', 'fps=30',
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-crf', '18',
                '-g', '1',
                '-keyint_min', '1',
                '-an',
                output_path,
            ],
            stderr=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            universal_newlines=True,
        )

        buf = ''
        for char in iter(lambda: proc.stderr.read(1), ''):
            buf += char
            if char in ('\r', '\n'):
                line = buf.strip()
                buf = ''
                if not line:
                    continue
                # Parse total duration from initial output
                if job['duration'] is None:
                    d = parse_duration(line)
                    if d:
                        job['duration'] = d
                # Parse current time for progress
                t = parse_time(line)
                if t and job['duration']:
                    job['progress'] = min(99, int(t / job['duration'] * 100))

        proc.wait()
        if proc.returncode != 0:
            job['status'] = 'error'
            job['error'] = 'ffmpeg exited with code ' + str(proc.returncode)
        else:
            job['progress'] = 100
            job['status'] = 'done'
            # Clean up input file
            try:
                os.remove(input_path)
            except OSError:
                pass

    except FileNotFoundError:
        job['status'] = 'error'
        job['error'] = 'ffmpeg not found — install ffmpeg and ensure it is on PATH'
    except Exception as e:
        job['status'] = 'error'
        job['error'] = str(e)


@app.route('/preprocess/<job_id>/status')
def job_status(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({'error': 'unknown job'}), 404
    return jsonify({
        'status': job['status'],
        'progress': job['progress'],
        'error': job['error'],
    })


@app.route('/preprocess/<job_id>/stream')
def job_stream(job_id):
    """SSE endpoint for real-time progress."""
    job = jobs.get(job_id)
    if not job:
        return jsonify({'error': 'unknown job'}), 404

    def generate():
        last_progress = -1
        while True:
            j = jobs.get(job_id)
            if not j:
                break
            if j['progress'] != last_progress or j['status'] in ('done', 'error'):
                last_progress = j['progress']
                payload = json.dumps({'status': j['status'], 'progress': j['progress'], 'error': j['error']})
                yield f"data: {payload}\n\n"
            if j['status'] in ('done', 'error'):
                break
            time.sleep(0.5)

    return Response(generate(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route('/preprocess/<job_id>/download')
def job_download(job_id):
    job = jobs.get(job_id)
    if not job or job['status'] != 'done':
        return jsonify({'error': 'not ready'}), 404
    return send_from_directory(PROCESSED_DIR, os.path.basename(job['output']),
                               as_attachment=False, mimetype='video/mp4')


if __name__ == '__main__':
    # Check ffmpeg availability
    try:
        result = subprocess.run(['ffmpeg', '-version'], capture_output=True, text=True)
        version_line = result.stdout.split('\n')[0] if result.stdout else 'unknown'
        print(f'ffmpeg found: {version_line}')
    except FileNotFoundError:
        print('WARNING: ffmpeg not found on PATH — /preprocess will fail')
        print('Install: brew install ffmpeg')

    print(f'Uploads: {UPLOAD_DIR}')
    print(f'Processed: {PROCESSED_DIR}')
    app.run(host='0.0.0.0', port=8080, debug=True)
