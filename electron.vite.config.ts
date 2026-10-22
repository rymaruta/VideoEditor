import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import product from './src/shared/product.json'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // ネイティブのアドオン(.node)は取り込めないので、実行時に node_modules から読む
        // (音声認識は @huggingface/transformers 経由で読まれるので元から外にある)
        external: ['onnxruntime-node', 'node-llama-cpp']
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      react(),
      // 窓の題名(起動直後に出る)を製品名から入れる。製品名は src/shared/product.json の1か所
      {
        name: 'product-name-html',
        transformIndexHtml: (html: string) => html.replaceAll('%PRODUCT_NAME%', product.name)
      }
    ]
  }
})
