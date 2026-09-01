---
name: css-animations
description: Анимации на чистом CSS — keyframes, свечение, маски, бесконечные петли, микровзаимодействия без JavaScript. Применять при любой работе с CSS-анимациями, transition, keyframes, hover-эффектами и лёгким движением в интерфейсе.
---

# CSS-анимации: плавно, легко, без JavaScript

## Два инструмента — два назначения

- `transition` — реакция на смену состояния (hover, открытие, класс).
- `@keyframes` + `animation` — самостоятельная жизнь: пульс, петля, появление.

## Тайминг, который «чувствуется правильно»

```css
:root {
  --e-out:  cubic-bezier(0.22, 1, 0.36, 1);   /* въезд: быстро → мягко */
  --e-in:   cubic-bezier(0.55, 0, 1, 0.45);   /* уход: разгоняется */
  --e-both: cubic-bezier(0.65, 0, 0.35, 1);   /* перемещение на экране */
}
```

- Появление 200–300 мс, исчезновение короче — 150–200 мс.
- `linear` — только для бесконечных петель (спиннер, бегущий градиент).

## Только дешёвые свойства

Анимировать **transform и opacity** — их рисует композитор мимо раскладки.
`width/height/top/left/margin` вызывают reflow каждый кадр — не анимировать;
вместо движения через `left` — `transform: translateX()`. `filter` и
`box-shadow` — дорогие: свечение делать заранее отрисованной тенью на
псевдоэлементе и анимировать его `opacity`:

```css
.btn::after { content:''; position:absolute; inset:0; border-radius:inherit;
  box-shadow:0 0 24px 4px var(--glow); opacity:0; transition:opacity .25s var(--e-out); }
.btn:hover::after { opacity:1; }
```

## Петли, маски, ступеньки

- Бегущий блик: градиент + `background-position` в keyframes, либо
  `mask-image: linear-gradient(...)` со сдвигом маски.
- Ступенчатая анимация спрайтов/цифр: `animation-timing-function: steps(n)`.
- Каскад списка: одна анимация + `animation-delay: calc(var(--i) * 40ms)`,
  где `--i` проставлен инлайном на элементе.

## Обязательные мелочи (выстраданы в этом проекте)

- `animation-fill-mode: backwards` на всём, что появляется с задержкой —
  иначе до старта анимации элемент виден в конечном состоянии (мигание).
- Анимации в скрытой панели (`display:none`, фоновая вкладка) не тикают:
  не завязывать на них логику; после показа панели — перезапуск класса.
- Уважать людей: `@media (prefers-reduced-motion: reduce) { * {
  animation-duration:.01ms !important; transition-duration:.01ms !important } }`
- Прозрачность всего слоя ≠ прозрачность фона: анимируя `opacity` оверлея,
  вы делаете полупрозрачным и его содержимое. Фон гасить отдельным слоем.
