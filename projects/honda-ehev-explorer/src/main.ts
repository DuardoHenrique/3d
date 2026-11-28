import './styles/main.css';
import { SceneController } from './scene/sceneController';
import { HudController } from './ui/hudController';

function bootstrap(): void {
  const container = document.getElementById('viewport-container');
  if (!container) {
    throw new Error('Missing #viewport-container element');
  }

  let hud: HudController | null = null;

  const sceneCtrl = new SceneController(
    container,
    (snapshot) => {
      hud?.syncState(snapshot);
    },
    (labels) => {
      hud?.updateLabels(labels);
    }
  );

  hud = new HudController(sceneCtrl);
  hud.syncState(sceneCtrl.getSnapshot());
}

bootstrap();
