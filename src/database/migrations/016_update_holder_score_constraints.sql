-- Update holder_scores constraints to allow bonding curve progress from 10% to 100%
-- This allows tracking tokens from activation (10%) until graduation (100%)

-- Drop the old constraint
ALTER TABLE holder_scores DROP CONSTRAINT IF EXISTS holder_scores_bonding_curve_progress_check;

-- Add the new constraint allowing 10-100% range
ALTER TABLE holder_scores ADD CONSTRAINT holder_scores_bonding_curve_progress_check 
  CHECK (bonding_curve_progress >= 10 AND bonding_curve_progress <= 100);

-- Add comment explaining the change
COMMENT ON COLUMN holder_scores.bonding_curve_progress IS 'Bonding curve progress percentage when score was calculated (10-100% range)';