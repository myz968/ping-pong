"""把 frames/*.webp 打包成内嵌 data URL，并注入 client.template.js 生成 client.js。

为什么单独写这个脚本，而不是复用 WorkBuddy 那边的 tools/build_frames.py：
    那个脚本的 PLUGIN 指向 `<项目>\dsh-plugin\fzd-pet`、PET 指向 `<项目>\pet`，
    这两个目录在本机已经不存在，直接跑会报错退出。
    本脚本只做「注入」这一步，不重新生成帧 —— 帧已经由 build_frames.py 产好并拷到 frames/。

用法（在插件目录下）：
    python tools/build-client.py
"""
import base64
import json
import os
import sys

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAMES = os.path.join(PLUGIN, 'frames')
TPL = os.path.join(PLUGIN, 'client.template.js')
OUT = os.path.join(PLUGIN, 'client.js')
MARK = '/*__FZD_FRAMES__*/'
IDLE_N, HIT_N = 8, 8
IDLE_FPS, HIT_FPS = 8, 16


def read_webp(stem, index):
    path = os.path.join(FRAMES, '%s-%02d.webp' % (stem, index))
    if not os.path.exists(path):
        raise SystemExit('缺少帧文件: ' + path)
    with open(path, 'rb') as f:
        payload = f.read()
    return 'data:image/webp;base64,' + base64.b64encode(payload).decode('ascii')


def main():
    manifest = {
        'size': 256,
        'idleFps': IDLE_FPS,
        'hitFps': HIT_FPS,
        'idle': [read_webp('idle', i) for i in range(IDLE_N)],
        'hit': [read_webp('hit', i) for i in range(HIT_N)],
    }
    blob = json.dumps(manifest, separators=(',', ':'))
    print('frames payload: %.1f KiB (idle=%d hit=%d)'
          % (len(blob) / 1024, IDLE_N, HIT_N))

    with open(TPL, encoding='utf-8') as f:
        text = f.read()
    if MARK not in text:
        raise SystemExit('模板缺少占位符 ' + MARK)

    # 占位符在第 1 行，替换成 const 声明即可
    out = text.replace(MARK, 'const FZD_FRAMES = ' + blob + ';')
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(out)
    print('wrote %s (%.1f KiB)' % (OUT, os.path.getsize(OUT) / 1024))

    # 顺手做一次结构自检：占位符必须已经消失
    with open(OUT, encoding='utf-8') as f:
        body = f.read()
    if MARK in body:
        raise SystemExit('注入后仍残留占位符')
    print('ok')


if __name__ == '__main__':
    sys.exit(main())
