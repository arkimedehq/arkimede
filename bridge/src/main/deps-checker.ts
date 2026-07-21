import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface DepResult {
  name: string
  available: boolean
  version?: string
  installHint?: string
  installUrl?: string
}

async function checkCommand(cmd: string, versionArg = '--version'): Promise<{ available: boolean; version?: string }> {
  try {
    const { stdout } = await execFileAsync(cmd, [versionArg], { timeout: 5000 })
    const version = stdout.trim().split('\n')[0]
    return { available: true, version }
  } catch {
    return { available: false }
  }
}

export async function checkDependencies(): Promise<DepResult[]> {
  const results: DepResult[] = []

  // Node.js
  const nodeResult = await checkCommand('node')
  results.push({
    name: 'node',
    ...nodeResult,
    installHint: nodeResult.available ? undefined : 'Install Node.js from nodejs.org',
    installUrl: nodeResult.available ? undefined : 'https://nodejs.org/en/download'
  })

  // npm
  const npmResult = await checkCommand('npm')
  results.push({
    name: 'npm',
    ...npmResult,
    installHint: npmResult.available ? undefined : 'npm is included with Node.js. Reinstall Node.js',
    installUrl: npmResult.available ? undefined : 'https://nodejs.org/en/download'
  })

  // npx
  const npxResult = await checkCommand('npx')
  results.push({
    name: 'npx',
    ...npxResult,
    installHint: npxResult.available ? undefined : 'npx is included with Node.js >= 5.2. Update Node.js',
    installUrl: npxResult.available ? undefined : 'https://nodejs.org/en/download'
  })

  // Python 3
  const python3Result = await checkCommand('python3').catch(() => checkCommand('python'))
  results.push({
    name: 'python3',
    ...python3Result,
    installHint: python3Result.available ? undefined : 'Install Python 3 from python.org',
    installUrl: python3Result.available ? undefined : 'https://www.python.org/downloads/'
  })

  // pip3
  const pip3Result = await checkCommand('pip3').catch(() => checkCommand('pip'))
  results.push({
    name: 'pip3',
    ...pip3Result,
    installHint: pip3Result.available ? undefined : 'pip is included with Python 3. Reinstall Python',
    installUrl: pip3Result.available ? undefined : 'https://www.python.org/downloads/'
  })

  // uv / uvx
  const uvxResult = await checkCommand('uvx')
  results.push({
    name: 'uvx',
    ...uvxResult,
    installHint: uvxResult.available
      ? undefined
      : process.platform === 'win32'
        ? 'Install uv: powershell -c "irm https://astral.sh/uv/install.ps1 | iex"'
        : 'Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh',
    installUrl: uvxResult.available ? undefined : 'https://docs.astral.sh/uv/getting-started/installation/'
  })

  return results
}
