// Loads slices for a sample text via FontRuntime and lists them (plugin dogfood).
import { manifestUrl } from 'virtual:rword-fonts';
import { FontRuntime } from '@office-rs/font-runtime';

const rt = new FontRuntime({ manifests: [manifestUrl], includeDefaultNoto: false });
const codepoints = Array.from('你好世界,字体切片测试').map((c) => c.codePointAt(0)!);
await rt.ready();
const plan = rt.selectInitial(codepoints, []);
for await (const s of rt.ensure(plan)) {
  document.body.insertAdjacentHTML('beforeend',
    `<div>${s.family}/${s.id}: ${s.bytes.byteLength} bytes</div>`);
}
