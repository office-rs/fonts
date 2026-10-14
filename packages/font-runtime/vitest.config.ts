import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Spec files share workspace state (the @office-rs/fonts-fixture link in
    // node_modules, installed/removed by beforeAll/afterAll): parallel files
    // race on it — one file's afterAll can delete the link another file's
    // beforeAll just installed. Run files sequentially.
    fileParallelism: false,
  },
});
