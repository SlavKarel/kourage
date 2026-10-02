"""Browser-friendly subset of Python's turtle module for Kourage."""
import math
import html

_shapes = []
_background = "white"
_limit = 700


def _colour(value):
    if isinstance(value, (tuple, list)) and len(value) >= 3:
        values = list(value[:3])
        if all(isinstance(item, (int, float)) and 0 <= item <= 1 for item in values):
            values = [round(item * 255) for item in values]
        return "#%02x%02x%02x" % tuple(max(0, min(255, int(item))) for item in values)
    return str(value)


def _add(shape):
    if len(_shapes) >= _limit:
        raise RuntimeError("Слишком много линий turtle. Уменьшите число шагов или циклов.")
    _shapes.append(shape)


class Turtle:
    def __init__(self, *args, **kwargs):
        self._x = 0.0
        self._y = 0.0
        self._heading = 0.0
        self._down = True
        self._pen = "black"
        self._fill = "black"
        self._width = 2.0
        self._filling = False
        self._fill_points = []
        self._visible = True

    def _move(self, x, y):
        x, y = float(x), float(y)
        if self._down:
            _add(("line", self._x, self._y, x, y, self._pen, self._width))
        if self._filling:
            self._fill_points.append((x, y))
        self._x, self._y = x, y

    def forward(self, distance):
        angle = math.radians(self._heading)
        self._move(self._x + float(distance) * math.cos(angle), self._y + float(distance) * math.sin(angle))

    fd = forward

    def backward(self, distance):
        self.forward(-float(distance))

    back = backward
    bk = backward

    def right(self, angle):
        self._heading = (self._heading - float(angle)) % 360

    rt = right

    def left(self, angle):
        self._heading = (self._heading + float(angle)) % 360

    lt = left

    def goto(self, x, y=None):
        if y is None:
            x, y = x
        self._move(x, y)

    setpos = goto
    setposition = goto

    def setx(self, x):
        self._move(x, self._y)

    def sety(self, y):
        self._move(self._x, y)

    def position(self):
        return (self._x, self._y)

    pos = position

    def xcor(self):
        return self._x

    def ycor(self):
        return self._y

    def setheading(self, angle):
        self._heading = float(angle) % 360

    seth = setheading

    def heading(self):
        return self._heading

    def home(self):
        self.setheading(0)
        self.goto(0, 0)

    def penup(self):
        self._down = False

    pu = penup
    up = penup

    def pendown(self):
        self._down = True

    pd = pendown
    down = pendown

    def isdown(self):
        return self._down

    def pensize(self, width=None):
        if width is None:
            return self._width
        self._width = max(0.2, float(width))

    width = pensize

    def pencolor(self, *args):
        if not args:
            return self._pen
        self._pen = _colour(args if len(args) > 1 else args[0])

    def fillcolor(self, *args):
        if not args:
            return self._fill
        self._fill = _colour(args if len(args) > 1 else args[0])

    def color(self, *args):
        if not args:
            return (self._pen, self._fill)
        self.pencolor(args[0])
        self.fillcolor(args[-1])

    def begin_fill(self):
        self._filling = True
        self._fill_points = [(self._x, self._y)]

    def end_fill(self):
        if self._filling and len(self._fill_points) >= 3:
            _add(("polygon", tuple(self._fill_points), self._fill, self._pen, self._width))
        self._filling = False
        self._fill_points = []

    def circle(self, radius, extent=None, steps=None):
        radius = float(radius)
        extent = 360.0 if extent is None else float(extent)
        count = int(steps or max(12, min(180, abs(extent) / 5)))
        count = max(1, count)
        direction = 1 if radius >= 0 else -1
        angle = math.radians(self._heading)
        cx = self._x - math.sin(angle) * radius
        cy = self._y + math.cos(angle) * radius
        start = math.atan2(self._y - cy, self._x - cx)
        for index in range(1, count + 1):
            current = start + math.radians(extent * direction * index / count)
            self._move(cx + abs(radius) * math.cos(current), cy + abs(radius) * math.sin(current))
        self._heading = (self._heading + extent * direction) % 360

    def dot(self, size=None, *color):
        diameter = float(size if size is not None else max(self._width + 4, self._width * 2))
        fill = _colour(color if len(color) > 1 else color[0]) if color else self._pen
        _add(("dot", self._x, self._y, diameter / 2, fill))

    def write(self, text, move=False, align="left", font=("Arial", 12, "normal")):
        size = font[1] if isinstance(font, (tuple, list)) and len(font) > 1 else 12
        _add(("text", self._x, self._y, str(text), self._pen, float(size), str(align)))

    def distance(self, x, y=None):
        if y is None:
            x, y = x
        return math.hypot(float(x) - self._x, float(y) - self._y)

    def towards(self, x, y=None):
        if y is None:
            x, y = x
        return math.degrees(math.atan2(float(y) - self._y, float(x) - self._x)) % 360

    def speed(self, value=None):
        return 0

    def reset(self):
        clear()
        self.__init__()

    def clear(self):
        clear()

    def hideturtle(self):
        self._visible = False

    ht = hideturtle

    def showturtle(self):
        self._visible = True

    st = showturtle

    def isvisible(self):
        return self._visible

    def tracer(self, *args, **kwargs):
        return None

    def update(self):
        return None

    def shape(self, *args, **kwargs):
        return "classic"

    def stamp(self):
        self.dot(max(6, self._width * 3))
        return len(_shapes)

    def clearstamp(self, *args, **kwargs):
        return None

    def onclick(self, *args, **kwargs):
        return None


RawTurtle = Turtle
Pen = Turtle
_default = Turtle()


class _Screen:
    def bgcolor(self, *args):
        return bgcolor(*args)

    def tracer(self, *args, **kwargs):
        return None

    def update(self):
        return None

    def setup(self, *args, **kwargs):
        return None

    def screensize(self, *args, **kwargs):
        return (800, 600)

    def title(self, *args, **kwargs):
        return None

    def exitonclick(self):
        return None

    def bye(self):
        return None

    def listen(self):
        return None

    def onkey(self, *args, **kwargs):
        return None

    def onclick(self, *args, **kwargs):
        return None

    def setworldcoordinates(self, *args, **kwargs):
        return None


_screen = _Screen()


def Screen():
    return _screen


def bgcolor(*args):
    global _background
    if not args:
        return _background
    _background = _colour(args if len(args) > 1 else args[0])


def colormode(value=None):
    return 255 if value is None else None


def setup(*args, **kwargs):
    return None


def title(*args, **kwargs):
    return None


def screensize(*args, **kwargs):
    return (800, 600)


def listen():
    return None


def onkey(*args, **kwargs):
    return None


def onclick(*args, **kwargs):
    return None


def setworldcoordinates(*args, **kwargs):
    return None


def bye():
    return None


def clear():
    _shapes.clear()


def reset():
    _default.reset()


def done():
    return None


mainloop = done
exitonclick = done
update = lambda: None
tracer = lambda *args, **kwargs: None
speed = _default.speed
forward = _default.forward
fd = _default.fd
backward = _default.backward
back = _default.back
bk = _default.bk
right = _default.right
rt = _default.rt
left = _default.left
lt = _default.lt
goto = _default.goto
setpos = _default.setpos
setposition = _default.setposition
setx = _default.setx
sety = _default.sety
position = _default.position
pos = _default.pos
xcor = _default.xcor
ycor = _default.ycor
setheading = _default.setheading
seth = _default.seth
heading = _default.heading
home = _default.home
penup = _default.penup
pu = _default.pu
up = _default.up
pendown = _default.pendown
pd = _default.pd
down = _default.down
isdown = _default.isdown
pensize = _default.pensize
width = _default.width
pencolor = _default.pencolor
fillcolor = _default.fillcolor
color = _default.color
begin_fill = _default.begin_fill
end_fill = _default.end_fill
circle = _default.circle
dot = _default.dot
write = _default.write
distance = _default.distance
towards = _default.towards
hideturtle = _default.hideturtle
ht = _default.ht
showturtle = _default.showturtle
st = _default.st
shape = _default.shape
stamp = _default.stamp


def _kourage_svg():
    if not _shapes:
        return ""
    points = []
    for shape in _shapes:
        if shape[0] == "line":
            points.extend(((shape[1], shape[2]), (shape[3], shape[4])))
        elif shape[0] in ("dot", "text"):
            points.append((shape[1], shape[2]))
        elif shape[0] == "polygon":
            points.extend(shape[1])
    xs = [point[0] for point in points] or [0]
    ys = [point[1] for point in points] or [0]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    width = max(160.0, max_x - min_x + 80)
    height = max(120.0, max_y - min_y + 80)
    view_x = (min_x + max_x) / 2 - width / 2
    view_y = -((min_y + max_y) / 2) - height / 2
    result = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_x:.2f} {view_y:.2f} {width:.2f} {height:.2f}" role="img" aria-label="Рисунок turtle">']
    result.append(f'<rect x="{view_x:.2f}" y="{view_y:.2f}" width="{width:.2f}" height="{height:.2f}" fill="{html.escape(_background, quote=True)}"/>')
    for shape in _shapes:
        kind = shape[0]
        if kind == "line":
            _, x1, y1, x2, y2, stroke, line_width = shape
            result.append(f'<line x1="{x1:.2f}" y1="{-y1:.2f}" x2="{x2:.2f}" y2="{-y2:.2f}" stroke="{html.escape(stroke, quote=True)}" stroke-width="{line_width:.2f}" stroke-linecap="round"/>')
        elif kind == "polygon":
            _, polygon, fill, stroke, line_width = shape
            coords = " ".join(f"{x:.2f},{-y:.2f}" for x, y in polygon)
            result.append(f'<polygon points="{coords}" fill="{html.escape(fill, quote=True)}" stroke="{html.escape(stroke, quote=True)}" stroke-width="{line_width:.2f}"/>')
        elif kind == "dot":
            _, x, y, radius, fill = shape
            result.append(f'<circle cx="{x:.2f}" cy="{-y:.2f}" r="{radius:.2f}" fill="{html.escape(fill, quote=True)}"/>')
        elif kind == "text":
            _, x, y, text, fill, size, align = shape
            anchor = {"center": "middle", "right": "end"}.get(align, "start")
            result.append(f'<text x="{x:.2f}" y="{-y:.2f}" fill="{html.escape(fill, quote=True)}" font-family="sans-serif" font-size="{size:.2f}" text-anchor="{anchor}">{html.escape(text)}</text>')
    result.append('</svg>')
    return "".join(result)
