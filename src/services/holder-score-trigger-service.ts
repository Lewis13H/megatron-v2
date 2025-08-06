import { getDbPool } from '../database/connection';
import { HolderScoreAnalyzer } from '../scoring/holder-score-implementation';
import { getHeliusService } from './helius-api-service';

interface TriggerConfig {
  progressMilestones: number[];
  velocityThresholds: {
    minutes: number;
    progressChange: number;
    priority: number;
  }[];
  checkIntervalSeconds: number;
}

export class HolderScoreTriggerService {
  private config: TriggerConfig = {
    progressMilestones: [10, 15, 25, 50, 75, 90, 95, 100],
    velocityThresholds: [
      { minutes: 15, progressChange: 5, priority: 2 },
      { minutes: 60, progressChange: 10, priority: 3 },
      { minutes: 1440, progressChange: 20, priority: 4 } // 24 hours
    ],
    checkIntervalSeconds: 30 // Check every 30 seconds
  };

  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private holderScoreAnalyzer: HolderScoreAnalyzer;

  constructor(heliusApiKey: string, rpcUrl: string) {
    this.holderScoreAnalyzer = new HolderScoreAnalyzer(heliusApiKey, rpcUrl);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Holder score trigger service already running');
      return;
    }

    console.log('🎯 Starting Holder Score Trigger Service');
    console.log(`📊 Monitoring progress milestones: ${this.config.progressMilestones.join(', ')}%`);
    console.log(`⚡ Check interval: ${this.config.checkIntervalSeconds} seconds`);
    
    this.isRunning = true;

    // Initial check
    await this.checkForTriggers();

    // Set up interval
    this.intervalId = setInterval(async () => {
      if (this.isRunning) {
        await this.checkForTriggers();
      }
    }, this.config.checkIntervalSeconds * 1000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('Holder score trigger service stopped');
  }

  private async checkForTriggers(): Promise<void> {
    const db = getDbPool();
    
    try {
      // Get tokens with updated bonding curve progress
      const query = `
        WITH progress_changes AS (
          SELECT 
            t.id,
            t.mint_address,
            t.symbol,
            t.created_at,
            p.bonding_curve_progress as current_progress,
            COALESCE(t.last_holder_score_progress, 0) as last_progress,
            t.last_holder_score_update,
            t.holder_score_milestones
          FROM tokens t
          JOIN pools p ON t.id = p.token_id
          WHERE p.platform = 'pumpfun'
            AND p.status = 'active'
            AND p.bonding_curve_progress >= 10
            AND p.bonding_curve_progress < 100
            AND (
              -- Progress changed significantly
              ABS(p.bonding_curve_progress - COALESCE(t.last_holder_score_progress, 0)) > 0.1
              -- Or never analyzed
              OR t.last_holder_score_update IS NULL
              -- Or due for time-based update
              OR t.last_holder_score_update < NOW() - CASE
                WHEN p.bonding_curve_progress < 25 THEN INTERVAL '15 minutes'
                WHEN p.bonding_curve_progress < 50 THEN INTERVAL '30 minutes'
                WHEN p.bonding_curve_progress < 75 THEN INTERVAL '45 minutes'
                WHEN p.bonding_curve_progress < 95 THEN INTERVAL '15 minutes'
                ELSE INTERVAL '5 minutes'
              END
            )
        )
        SELECT * FROM progress_changes
        LIMIT 50
      `;

      const result = await db.query(query);

      for (const token of result.rows) {
        await this.evaluateToken(token);
      }

      // Process high-priority queue items
      await this.processQueue();

    } catch (error) {
      console.error('Error checking triggers:', error);
    }
  }

  private async evaluateToken(token: any): Promise<void> {
    const db = getDbPool();
    
    try {
      const triggers = await this.checkTriggers(
        token.id,
        token.current_progress,
        token.last_progress,
        token.last_holder_score_update
      );

      if (triggers.length > 0) {
        // Add to queue with highest priority trigger
        const highestPriority = Math.min(...triggers.map(t => t.priority));
        const trigger = triggers.find(t => t.priority === highestPriority);

        if (trigger) {
          const insertQuery = `
            INSERT INTO holder_score_queue (token_id, trigger_type, trigger_reason, priority)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (token_id, trigger_type) 
            DO UPDATE SET 
              trigger_reason = $3,
              priority = LEAST(holder_score_queue.priority, $4),
              created_at = NOW()
          `;

          await db.query(insertQuery, [
            token.id,
            trigger.type,
            trigger.reason,
            trigger.priority
          ]);

          console.log(`📍 Queued ${token.symbol}: ${trigger.reason} (priority ${trigger.priority})`);
        }
      }
    } catch (error) {
      console.error(`Error evaluating token ${token.symbol}:`, error);
    }
  }

  private async checkTriggers(
    tokenId: string,
    currentProgress: number,
    lastProgress: number,
    lastUpdate: Date | null
  ): Promise<Array<{type: string, reason: string, priority: number}>> {
    const triggers: Array<{type: string, reason: string, priority: number}> = [];

    // Check milestone triggers
    for (const milestone of this.config.progressMilestones) {
      if (lastProgress < milestone && currentProgress >= milestone) {
        triggers.push({
          type: 'milestone',
          reason: `Crossed ${milestone}% milestone`,
          priority: milestone >= 90 ? 1 : milestone >= 75 ? 2 : milestone === 10 ? 3 : 5
        });
      }
    }

    // Check velocity triggers
    if (lastUpdate) {
      const timeDiffMinutes = (Date.now() - new Date(lastUpdate).getTime()) / (1000 * 60);
      const progressChange = currentProgress - lastProgress;

      for (const threshold of this.config.velocityThresholds) {
        if (timeDiffMinutes <= threshold.minutes && progressChange >= threshold.progressChange) {
          triggers.push({
            type: 'velocity',
            reason: `Rapid progress: +${progressChange.toFixed(1)}% in ${timeDiffMinutes.toFixed(0)} minutes`,
            priority: threshold.priority
          });
          break; // Only add one velocity trigger
        }
      }
    }

    return triggers;
  }

  private async processQueue(): Promise<void> {
    const db = getDbPool();
    
    try {
      // Get highest priority items from queue
      const queueQuery = `
        SELECT 
          q.*,
          t.mint_address,
          t.symbol,
          t.created_at as token_created_at,
          p.bonding_curve_progress,
          (SELECT COUNT(*) FROM transactions WHERE token_id = q.token_id) as transaction_count
        FROM holder_score_queue q
        JOIN tokens t ON q.token_id = t.id
        JOIN pools p ON t.id = p.token_id
        WHERE q.processed_at IS NULL
          AND t.created_at < NOW() - INTERVAL '30 minutes'
          AND (SELECT COUNT(*) FROM transactions WHERE token_id = q.token_id) >= 3
        ORDER BY q.priority, q.created_at
        LIMIT 5
      `;

      const queueItems = await db.query(queueQuery);

      for (const item of queueItems.rows) {
        console.log(`\n🔄 Processing ${item.symbol} - ${item.trigger_reason}`);
        
        try {
          // Analyze the token
          const score = await this.holderScoreAnalyzer.analyzeToken(
            item.mint_address,
            item.bonding_curve_progress,
            undefined,
            new Date(item.token_created_at)
          );

          if (score) {
            // Update token tracking
            await db.query(`
              UPDATE tokens 
              SET 
                last_holder_score_progress = $2,
                last_holder_score_update = NOW(),
                holder_score_milestones = holder_score_milestones || $3::jsonb
              WHERE id = $1
            `, [
              item.token_id,
              item.bonding_curve_progress,
              JSON.stringify([Math.floor(item.bonding_curve_progress)])
            ]);

            console.log(`✅ Score calculated: ${score.total}/333`);
          }

          // Mark as processed
          await db.query(
            'UPDATE holder_score_queue SET processed_at = NOW() WHERE id = $1',
            [item.id]
          );

        } catch (error) {
          console.error(`Error processing ${item.symbol}:`, error);
          // Don't mark as processed so it can be retried
        }
      }

      // Clean up old processed items
      await db.query(
        'DELETE FROM holder_score_queue WHERE processed_at < NOW() - INTERVAL \'1 hour\''
      );

    } catch (error) {
      console.error('Error processing queue:', error);
    }
  }
}

// Export function to start the service
export async function startHolderScoreTriggerService(
  heliusApiKey: string,
  rpcUrl: string
): Promise<HolderScoreTriggerService> {
  const service = new HolderScoreTriggerService(heliusApiKey, rpcUrl);
  await service.start();
  return service;
}