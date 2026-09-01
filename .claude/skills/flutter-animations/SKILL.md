---
name: flutter-animations
description: Нативные анимации Flutter — implicit/explicit animations, Hero-переходы между экранами, физика пружин, производительность без потери кадров. Применять при работе с Flutter/Dart-кодом и вопросах о мобильных анимациях в нём.
---

# Flutter: анимации без потери кадров

## Лестница сложности — идти снизу

1. **Implicit** (`AnimatedContainer`, `AnimatedOpacity`, `AnimatedPositioned`,
   `AnimatedSwitcher`) — смена значения сама анимируется. 80% случаев.
2. **TweenAnimationBuilder** — одноразовая анимация к цели без контроллера.
3. **Explicit** (`AnimationController` + `AnimatedBuilder`) — когда нужно
   управлять: пауза, реверс, повтор, связка нескольких кривых.
4. Физика (`SpringSimulation`, `.fling`) — когда движение продолжает жест.

Не начинать с контроллера там, где хватит `AnimatedContainer`.

## Explicit-каркас без утечек

```dart
class _S extends State<W> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this,
      duration: const Duration(milliseconds: 250));
  late final _fade = CurvedAnimation(parent: _c, curve: Curves.easeOutCubic);

  @override
  void dispose() { _c.dispose(); super.dispose(); } // обязателен
}
```

- Несколько фаз одной анимации — `Interval(0.0, 0.6)` внутри `CurvedAnimation`,
  а не второй контроллер.
- `AnimatedBuilder`-у передавать `child:` — поддерево не перестраивается
  каждый кадр, двигается только обёртка.

## Hero-переходы

```dart
Hero(tag: 'card-$id', child: CardWidget(...))
```

- Тег уникален и одинаков на обоих экранах.
- Внутри Hero не держать виджеты с состоянием, зависящим от контекста
  (Material нужен: оборачивать в `Material(type: MaterialType.transparency)`,
  иначе текст в полёте подчёркнут жёлтым).
- Кастомная траектория — `flightShuttleBuilder`.

## Пружины и жесты

Шторка/карточка, отпущенная пальцем, продолжает движение со скоростью жеста:

```dart
_c.animateWith(SpringSimulation(
  SpringDescription.withDampingRatio(mass: 1, stiffness: 500, ratio: 0.9),
  _c.value, target, velocity));
```

`ratio` < 1 — лёгкий перелёт (живо), 1.0 — без перелёта (строго).

## Производительность

- Тяжёлое поддерево под анимацией — обернуть в `RepaintBoundary`.
- Не запускать анимации в `build`; только из `initState`/обработчиков.
- Списки — `ListView.builder`; каскад появления через
  `AnimationLimiter`-подход: задержка `min(index, 8) * 40ms`.
- Проверять профиль в **profile mode** на реальном устройстве:
  jank в debug ничего не значит, а в release его может не быть.
- `Opacity` в анимации → заменить на `FadeTransition` (не пересобирает слой).
