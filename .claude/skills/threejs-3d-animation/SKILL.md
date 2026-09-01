---
name: threejs-3d-animation
description: 3D-анимация в браузере на Three.js — сцены, GLTF-модели, скелетная анимация, плавные переходы поз, физика и damping. Применять, когда просят 3D-графику, WebGL, вращающиеся объекты, 3D-баннеры или анимированные модели на сайте.
---

# Three.js: 3D-анимация в вебе

## Каркас сцены — всегда один и тот же

```js
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); // >2 — трата батареи без пользы
renderer.setSize(w, h);
```

Цикл — через `renderer.setAnimationLoop(tick)`, не через свой rAF:
он сам останавливается, когда вкладка скрыта, и дружит с WebXR.

## Правила движения

- Всё движение — от **дельты времени**, не от номера кадра:
  `const dt = clock.getDelta(); mesh.rotation.y += speed * dt;`
- Плавное следование (damping) вместо прыжка к цели:
  `value += (target - value) * Math.min(1, dt * 8)` — классический экспоненциальный догон.
- Физика падений/пружин: библиотечная (cannon-es) только если объектов много;
  для одного объекта хватает ручной скорости + затухания `v *= 0.92`.

## GLTF и скелетная анимация

```js
const gltf = await new GLTFLoader().loadAsync('model.glb');
const mixer = new THREE.AnimationMixer(gltf.scene);
const run = mixer.clipAction(gltf.animations.find(a => a.name === 'Run'));
run.play();
// в tick: mixer.update(dt);
```

Смешивание поз — через `crossFadeTo(next, 0.3)` — резкая смена клипа всегда
выглядит дёшево. Вес позы (`action.setEffectiveWeight`) — для частичных
наложений (бег + махание рукой).

## Производительность

- Один `WebGLRenderer` на страницу. Несколько сцен — несколько viewport-ов
  через `setScissor`, а не несколько канвасов.
- Тени дорогие: одна `DirectionalLight` с тенью, остальные света без.
- `mesh.matrixAutoUpdate = false` для неподвижного окружения.
- Убирать за собой: `geometry.dispose()`, `material.dispose()`,
  `renderer.dispose()` при демонтаже — иначе утечёт видеопамять.

## Ловушки

- Канвас в скрытом блоке имеет размер 0×0 — инициализировать сцену только
  когда контейнер виден, либо пересчитать размер при показе.
- `devicePixelRatio` на телефонах 3–4: без ограничения рендер в 4К на бюджетном
  устройстве. Всегда `Math.min(dpr, 2)`.
- Свет в GLTF из Блендера приезжает в других единицах — выставлять свет кодом.
