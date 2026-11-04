import { MatchBoard } from '@/components/match-board';

export default function Live() {
  return <MatchBoard initialFilter="live" showFeatured={false} />;
}
