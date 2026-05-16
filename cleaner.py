#!/usr/bin/env python3
"""Video cleaner for scrubbing — all-keyframe H.264, 30fps, no audio."""

import sys
import os
import subprocess
import threading
from pathlib import Path
from PyQt6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QHBoxLayout, QLabel,
    QPushButton, QFileDialog, QProgressBar, QListWidget, QListWidgetItem
)
from PyQt6.QtCore import Qt, pyqtSignal, QMimeData
from PyQt6.QtGui import QDragEnterEvent, QDropEvent


FFMPEG_CMD = [
    'ffmpeg', '-y', '-i', '{input}',
    '-vf', 'fps=30',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-g', '1', '-keyint_min', '1',
    '-an',
    '{output}'
]

VIDEO_EXTS = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg'}


class DropZone(QListWidget):
    filesDropped = pyqtSignal(list)

    def __init__(self):
        super().__init__()
        self.setAcceptDrops(True)
        self.setDragDropMode(QListWidget.DragDropMode.DropOnly)
        self.setStyleSheet("""
            QListWidget {
                background: #1a1a1a; color: #ccc; border: 2px dashed #444;
                border-radius: 8px; font-size: 13px; padding: 8px;
            }
            QListWidget::item { padding: 4px 8px; }
            QListWidget::item:selected { background: #2a2a3a; }
        """)
        placeholder = QListWidgetItem("Drop video files here or click 'Add Files'")
        placeholder.setFlags(Qt.ItemFlag.NoItemFlags)
        placeholder.setForeground(Qt.GlobalColor.darkGray)
        self.addItem(placeholder)
        self._has_placeholder = True

    def dragEnterEvent(self, event: QDragEnterEvent):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dragMoveEvent(self, event):
        event.acceptProposedAction()

    def dropEvent(self, event: QDropEvent):
        paths = []
        for url in event.mimeData().urls():
            p = url.toLocalFile()
            if Path(p).suffix.lower() in VIDEO_EXTS:
                paths.append(p)
        if paths:
            self.filesDropped.emit(paths)

    def clear_placeholder(self):
        if self._has_placeholder:
            self.clear()
            self._has_placeholder = False


class CleanerApp(QWidget):
    progress_update = pyqtSignal(int, str)  # index, status text
    file_done = pyqtSignal(int)
    all_done = pyqtSignal()

    def __init__(self):
        super().__init__()
        self.setWindowTitle('Video Cleaner')
        self.setMinimumSize(500, 400)
        self.setStyleSheet("background: #111; color: #ccc;")
        self.files = []  # list of absolute paths
        self.output_dir = str(Path.home() / 'Desktop')
        self.processing = False
        self.init_ui()
        self.progress_update.connect(self._on_progress)
        self.file_done.connect(self._on_file_done)
        self.all_done.connect(self._on_all_done)

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(10)

        title = QLabel('Video Cleaner')
        title.setStyleSheet('font-size: 18px; font-weight: bold; color: #fff; padding: 4px;')
        layout.addWidget(title)

        subtitle = QLabel('All-keyframe H.264 · 30fps · no audio · ready for scrubbing')
        subtitle.setStyleSheet('font-size: 11px; color: #666; padding: 0 4px 8px;')
        layout.addWidget(subtitle)

        # Drop zone
        self.drop_zone = DropZone()
        self.drop_zone.filesDropped.connect(self.add_files)
        layout.addWidget(self.drop_zone, 1)

        # Buttons row
        btn_row = QHBoxLayout()
        self.add_btn = QPushButton('Add Files')
        self.add_btn.setStyleSheet(self._btn_style())
        self.add_btn.clicked.connect(self.pick_files)
        btn_row.addWidget(self.add_btn)

        self.clear_btn = QPushButton('Clear')
        self.clear_btn.setStyleSheet(self._btn_style('#333'))
        self.clear_btn.clicked.connect(self.clear_files)
        btn_row.addWidget(self.clear_btn)

        btn_row.addStretch()

        self.out_btn = QPushButton(f'Save to: Desktop')
        self.out_btn.setStyleSheet(self._btn_style('#1a2a1a'))
        self.out_btn.clicked.connect(self.pick_output)
        btn_row.addWidget(self.out_btn)

        layout.addLayout(btn_row)

        # Progress
        self.progress = QProgressBar()
        self.progress.setStyleSheet("""
            QProgressBar { background: #222; border: 1px solid #333; border-radius: 4px; height: 20px; text-align: center; color: #aaa; }
            QProgressBar::chunk { background: #2d7d2d; border-radius: 3px; }
        """)
        self.progress.setValue(0)
        self.progress.setFormat('')
        layout.addWidget(self.progress)

        # Clean button
        self.clean_btn = QPushButton('Clean All')
        self.clean_btn.setStyleSheet(self._btn_style('#1a3a1a', 16))
        self.clean_btn.clicked.connect(self.start_clean)
        layout.addWidget(self.clean_btn)

    def _btn_style(self, bg='#1a1a2a', size=12):
        return f'QPushButton {{ background: {bg}; color: #ccc; border: 1px solid #333; border-radius: 4px; padding: 6px 14px; font-size: {size}px; }} QPushButton:hover {{ background: #2a2a3a; }}'

    def add_files(self, paths):
        self.drop_zone.clear_placeholder()
        for p in paths:
            if p not in self.files:
                self.files.append(p)
                item = QListWidgetItem(f'  ⏳  {Path(p).name}')
                self.drop_zone.addItem(item)

    def pick_files(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, 'Select videos', '',
            'Video files (*.mp4 *.mov *.avi *.mkv *.webm *.m4v *.flv);;All files (*)'
        )
        if paths:
            self.add_files(paths)

    def pick_output(self):
        d = QFileDialog.getExistingDirectory(self, 'Save cleaned files to', self.output_dir)
        if d:
            self.output_dir = d
            self.out_btn.setText(f'Save to: {Path(d).name}')

    def clear_files(self):
        self.files.clear()
        self.drop_zone.clear()
        self.drop_zone._has_placeholder = False
        self.progress.setValue(0)
        self.progress.setFormat('')

    def start_clean(self):
        if self.processing or not self.files:
            return
        self.processing = True
        self.clean_btn.setEnabled(False)
        self.clean_btn.setText('Processing...')
        self.progress.setMaximum(len(self.files))
        self.progress.setValue(0)
        threading.Thread(target=self._process_all, daemon=True).start()

    def _process_all(self):
        for i, filepath in enumerate(self.files):
            name = Path(filepath).stem
            ext = '.mp4'
            output = os.path.join(self.output_dir, f'{name}_clean{ext}')
            self.progress_update.emit(i, f'Cleaning {Path(filepath).name}...')
            cmd = [
                'ffmpeg', '-y', '-i', filepath,
                '-vf', 'fps=30',
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
                '-g', '1', '-keyint_min', '1',
                '-an', output
            ]
            try:
                result = subprocess.run(cmd, capture_output=True, text=True)
                if result.returncode == 0:
                    self.file_done.emit(i)
                else:
                    self.progress_update.emit(i, f'FAILED: {Path(filepath).name}')
            except Exception as e:
                self.progress_update.emit(i, f'ERROR: {e}')
        self.all_done.emit()

    def _on_progress(self, idx, text):
        self.progress.setFormat(text)
        item = self.drop_zone.item(idx)
        if item:
            item.setText(f'  ⏳  {Path(self.files[idx]).name}')

    def _on_file_done(self, idx):
        self.progress.setValue(idx + 1)
        item = self.drop_zone.item(idx)
        if item:
            item.setText(f'  ✅  {Path(self.files[idx]).name}')

    def _on_all_done(self):
        self.processing = False
        self.clean_btn.setEnabled(True)
        self.clean_btn.setText('Clean All')
        self.progress.setFormat('Done!')


if __name__ == '__main__':
    app = QApplication(sys.argv)
    window = CleanerApp()
    window.show()
    sys.exit(app.exec())
