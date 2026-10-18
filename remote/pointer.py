#!/usr/bin/env python3
"""Puntero X11 real para el mando de la tele (XTest, sin dependencias).

Lee órdenes de stdin, una por línea:
  m DX DY      movimiento relativo (acepta decimales; guarda el resto)
  w DX DY      desplazamiento en píxeles (+Y = hacia abajo); se convierte en ticks de rueda
  b N 1|0      botón N pulsado (1) o soltado (0)
  c N          clic completo con el botón N
  q            imprime la posición actual del puntero ("pos X Y")
Oculta el cursor tras 3 s sin uso (XFixes) y lo muestra al volver a usarlo.
"""
import ctypes as C
import os
import select
import sys
import time

TICK = 30.0          # píxeles de dedo por tick de rueda
MAX_TICKS = 24       # tope de ticks por orden, para no inundar a X
HIDE_AFTER = 3.0     # segundos de inactividad antes de ocultar el cursor

x11 = C.CDLL('libX11.so.6')
xtst = C.CDLL('libXtst.so.6')
try:
    xfx = C.CDLL('libXfixes.so.3')
except OSError:
    xfx = None

vp = C.c_void_p
x11.XOpenDisplay.restype = vp
x11.XOpenDisplay.argtypes = [C.c_char_p]
x11.XFlush.argtypes = [vp]
x11.XDefaultRootWindow.restype = C.c_ulong
x11.XDefaultRootWindow.argtypes = [vp]
x11.XQueryPointer.argtypes = [vp, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_ulong),
                              C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_int),
                              C.POINTER(C.c_int), C.POINTER(C.c_uint)]
xtst.XTestFakeRelativeMotionEvent.argtypes = [vp, C.c_int, C.c_int, C.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [vp, C.c_uint, C.c_int, C.c_ulong]
if xfx:
    xfx.XFixesQueryVersion.argtypes = [vp, C.POINTER(C.c_int), C.POINTER(C.c_int)]
    xfx.XFixesHideCursor.argtypes = [vp, C.c_ulong]
    xfx.XFixesShowCursor.argtypes = [vp, C.c_ulong]


def open_display():
    while True:
        d = x11.XOpenDisplay(None)  # usa la variable DISPLAY
        if d:
            return d
        time.sleep(1)


dpy = open_display()
root = x11.XDefaultRootWindow(dpy)
can_hide = False
if xfx:
    major, minor = C.c_int(4), C.c_int(0)
    can_hide = bool(xfx.XFixesQueryVersion(dpy, C.byref(major), C.byref(minor)))

hidden = False
ax = ay = 0.0   # resto fraccionario del movimiento
sx = sy = 0.0   # resto fraccionario del desplazamiento


def show():
    global hidden
    if hidden and can_hide:
        xfx.XFixesShowCursor(dpy, root)
        hidden = False


def hide():
    global hidden
    if not hidden and can_hide:
        xfx.XFixesHideCursor(dpy, root)
        x11.XFlush(dpy)
        hidden = True


def button(n, down):
    xtst.XTestFakeButtonEvent(dpy, n, 1 if down else 0, 0)


def wheel(btn, count):
    for _ in range(min(count, MAX_TICKS)):
        button(btn, True)
        button(btn, False)


def handle(p):
    global ax, ay, sx, sy
    if not p:
        return
    c = p[0]
    try:
        if c == 'm' and len(p) == 3:
            show()
            ax += float(p[1])
            ay += float(p[2])
            ix, iy = int(ax), int(ay)
            ax -= ix
            ay -= iy
            if ix or iy:
                xtst.XTestFakeRelativeMotionEvent(dpy, ix, iy, 0)
        elif c == 'w' and len(p) == 3:
            sx += float(p[1]) / TICK
            sy += float(p[2]) / TICK
            ty, tx = int(sy), int(sx)
            sy -= ty
            sx -= tx
            if ty:
                wheel(5 if ty > 0 else 4, abs(ty))
            if tx:
                wheel(7 if tx > 0 else 6, abs(tx))
        elif c == 'b' and len(p) == 3:
            show()
            button(int(p[1]), p[2] == '1')
        elif c == 'c' and len(p) >= 2:
            show()
            n = int(p[1])
            button(n, True)
            x11.XFlush(dpy)
            time.sleep(0.012)
            button(n, False)
        elif c == 'q':
            rw, ch = C.c_ulong(), C.c_ulong()
            rx, ry, wx, wy = C.c_int(), C.c_int(), C.c_int(), C.c_int()
            mask = C.c_uint()
            x11.XQueryPointer(dpy, root, C.byref(rw), C.byref(ch), C.byref(rx), C.byref(ry),
                              C.byref(wx), C.byref(wy), C.byref(mask))
            print('pos', rx.value, ry.value, flush=True)
    except (ValueError, OverflowError):
        pass


def main():
    buf = b''
    last = time.monotonic()
    fd = sys.stdin.fileno()
    while True:
        r, _, _ = select.select([fd], [], [], 0.5)
        now = time.monotonic()
        if r:
            data = os.read(fd, 65536)
            if not data:
                break
            buf += data
            *lines, buf = buf.split(b'\n')
            for ln in lines:
                handle(ln.decode('ascii', 'ignore').split())
            x11.XFlush(dpy)
            last = now
        elif not hidden and now - last > HIDE_AFTER:
            hide()


if __name__ == '__main__':
    main()
