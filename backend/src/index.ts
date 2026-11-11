import dns from 'node:dns'
import { existsSync } from 'node:fs'
import path from 'node:path'
import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import { env } from './config/env.ts'
import { closeDb, getDb } from './db/database.ts'
import { jobQueue } from './queue/jobQueue.ts'
import { clipsRouter } from './routes/clips.ts'
import { projectsRouter } from './routes/projects.ts'
import { systemRouter } from './routes/system.ts'
import { ensureDir } from './utils/fsSafe.ts'
import { log } from './utils/logger.ts'

// Ensure reliable Innertube networking on mixed IPv4/IPv6 environments
dns.setDefaultResultOrder('ipv4first')

export async function createApp(): Promise<express.Express> {
  await ensureDir(env.dataDir)
  getDb()

  const app = express()

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
  )
  app.use(cors())
  app.use(express.json({ limit: '2mb' }))

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
  app.use('/api', apiLimiter)

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'clipforge-ai', timestamp: new Date().toISOString() })
  })

  app.use('/api/projects', projectsRouter)
  app.use('/api/clips', clipsRouter)
  app.use('/api/system', systemRouter)

  // Serve built frontend in production if present
  if (existsSync(env.frontendDistDir)) {
    app.use(express.static(env.frontendDistDir))
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(env.frontendDistDir, 'index.html'))
    })
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.message.includes('Invalid resource identifier') ? 400 : 500
    log('error', 'HTTP', err.message)
    res.status(status).json({ error: err.message || 'Internal Server Error' })
  })

  return app
}

async function main(): Promise<void> {
  const app = await createApp()
  const server = app.listen(env.port, () => {
    log('info', 'Server', `OpenClipX backend listening on http://localhost:${env.port}`)
  })

  const gracefulShutdown = async (signal: string) => {
    log('warn', 'Server', `Received ${signal}, shutting down cleanly...`)
    await jobQueue.shutdownAll()
    server.close(() => {
      closeDb()
      process.exit(0)
    })
    setTimeout(() => {
      closeDb()
      process.exit(1)
    }, 5000).unref()
  }

  process.once('SIGINT', () => void gracefulShutdown('SIGINT'))
  process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'))
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]).replace(/\.ts$|\.js$/, '') ===
    new URL(import.meta.url).pathname.replace(/\.ts$|\.js$/, '')

if (isEntrypoint) {
  main().catch((err) => {
    console.error('Fatal server startup error:', err)
    process.exit(1)
  })
}

