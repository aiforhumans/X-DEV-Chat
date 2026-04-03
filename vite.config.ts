import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    define: {
      __X_DEV_SYSTEM_PROMPT_OPTIMIZER__: JSON.stringify(env.X_DEV_SYSTEM_PROMPT_OPTIMIZER ?? ''),
      __X_DEV_PERSONA_PROMPT_OPTIMIZER__: JSON.stringify(env.X_DEV_PERSONA_PROMPT_OPTIMIZER ?? ''),
      __X_DEV_SCENARIO_PROMPT_OPTIMIZER__: JSON.stringify(env.X_DEV_SCENARIO_PROMPT_OPTIMIZER ?? ''),
    },
  }
})
