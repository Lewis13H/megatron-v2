-- Add trigger tracking for holder score updates
-- This helps implement smart triggering based on bonding curve progress

-- Add fields to track progress milestones
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS last_holder_score_progress NUMERIC(5,2) DEFAULT 0;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS holder_score_milestones JSONB DEFAULT '[]'::jsonb;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS last_holder_score_update TIMESTAMPTZ;

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_tokens_holder_score_progress ON tokens(last_holder_score_progress) 
  WHERE platform = 'pumpfun';

-- Create a table to track pending holder score updates
CREATE TABLE IF NOT EXISTS holder_score_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token_id UUID REFERENCES tokens(id) NOT NULL,
  trigger_type VARCHAR(50) NOT NULL, -- 'milestone', 'velocity', 'volume', 'scheduled'
  trigger_reason TEXT,
  priority INTEGER DEFAULT 5, -- 1-10, 1 being highest priority
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE(token_id, trigger_type)
);

-- Index for queue processing
CREATE INDEX IF NOT EXISTS idx_holder_score_queue_pending 
  ON holder_score_queue(priority, created_at) 
  WHERE processed_at IS NULL;

-- Function to check if milestone was crossed
CREATE OR REPLACE FUNCTION should_trigger_holder_score_update(
  p_token_id UUID,
  p_current_progress NUMERIC,
  p_previous_progress NUMERIC
) RETURNS TABLE(trigger_type TEXT, reason TEXT, priority INT) AS $$
DECLARE
  milestones NUMERIC[] := ARRAY[10, 15, 25, 50, 75, 90, 95, 100];
  milestone NUMERIC;
  velocity NUMERIC;
  time_diff INTERVAL;
BEGIN
  -- Check milestone triggers
  FOREACH milestone IN ARRAY milestones LOOP
    IF p_previous_progress < milestone AND p_current_progress >= milestone THEN
      RETURN QUERY SELECT 
        'milestone'::TEXT,
        format('Crossed %s%% milestone', milestone)::TEXT,
        CASE 
          WHEN milestone >= 90 THEN 1  -- Highest priority near graduation
          WHEN milestone >= 75 THEN 2
          WHEN milestone = 10 THEN 3   -- First score is important
          ELSE 5
        END;
    END IF;
  END LOOP;
  
  -- Check velocity triggers
  velocity := p_current_progress - p_previous_progress;
  
  -- Get time since last update
  SELECT NOW() - last_holder_score_update INTO time_diff
  FROM tokens WHERE id = p_token_id;
  
  -- Rapid progress triggers
  IF time_diff < INTERVAL '15 minutes' AND velocity > 5 THEN
    RETURN QUERY SELECT 
      'velocity'::TEXT,
      format('Rapid progress: +%.1f%% in 15 minutes', velocity)::TEXT,
      2;
  ELSIF time_diff < INTERVAL '1 hour' AND velocity > 10 THEN
    RETURN QUERY SELECT 
      'velocity'::TEXT,
      format('Fast progress: +%.1f%% in 1 hour', velocity)::TEXT,
      3;
  END IF;
  
  RETURN;
END;
$$ LANGUAGE plpgsql;

-- Comments
COMMENT ON TABLE holder_score_queue IS 'Queue for pending holder score calculations with priority system';
COMMENT ON COLUMN tokens.last_holder_score_progress IS 'Bonding curve progress at last holder score calculation';
COMMENT ON COLUMN tokens.holder_score_milestones IS 'Array of progress milestones already processed';
COMMENT ON FUNCTION should_trigger_holder_score_update IS 'Determines if holder score should be recalculated based on progress changes';