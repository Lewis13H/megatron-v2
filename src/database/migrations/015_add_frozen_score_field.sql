-- Add frozen score field to holder_scores table
-- This field indicates whether the score is frozen (when token graduates at 100% bonding curve)

ALTER TABLE holder_scores ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN DEFAULT FALSE;

-- Add index for frozen scores
CREATE INDEX IF NOT EXISTS idx_holder_scores_frozen ON holder_scores (token_id, is_frozen) WHERE is_frozen = TRUE;

-- Add comment
COMMENT ON COLUMN holder_scores.is_frozen IS 'Indicates if this score is frozen (token reached 100% bonding curve progress)';