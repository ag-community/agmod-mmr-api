import { MatchDetail } from 'src/match_details/match-detail.entity';
import { PlayerPerformance } from '../types/player-performance';
import { rating, rate, Rating } from 'openskill';
import {
  calculateIndividualPerformance,
  calculatePerformanceAdjustment,
} from './performance';
import { determineWinner, organizeTeams } from './team';
import { Player } from 'src/players/player.entity';

/**
 * AGMMRCalculator - Advanced Gaming MMR Calculator
 *
 * This class implements a sophisticated MMR (Matchmaking Rating) system that:
 * - Uses OpenSkill library for robust rating calculations
 * - Accounts for individual player performance within team context
 * - Applies balance factors based on team skill disparities
 * - Implements carry/burden mechanics to reward exceptional individual play
 * - Maintains rating persistence across matches for all players
 */
export class AGMMRCalculator {
  // Cache of all player ratings using OpenSkill Rating objects
  // Key: steamID, Value: Rating (contains mu and sigma values)
  private _playerRatings: Map<string, Rating> = new Map();

  get playerRatings(): Map<string, Rating> {
    return this._playerRatings;
  }

  public ensurePlayerRatings(players: Player[]): void {
    for (const player of players) {
      const playerRating = rating({
        mu: player.skillMu,
        sigma: player.skillSigma,
      });
      this._playerRatings.set(player.steamID, playerRating);
    }
  }

  /**
   * Processes a complete match and calculates MMR changes for all players
   *
   * This is the main entry point that:
   * 1. Organizes players into teams based on their assigned colors
   * 2. Retrieves or creates initial ratings for all players
   * 3. Calculates team balance and skill disparities
   * 4. Determines match outcome and individual performances
   * 5. Updates ratings using OpenSkill's TrueSkill-based algorithm
   * 6. Converts rating changes to MMR deltas with various adjustments
   *
   * @param matchDetails - Array of all player match data for this game
   * @param previousMatchDetails - Previous match data for each player (null if first match)
   * @returns Updated matchDetails array with calculated MMR values
   */
  public processMatch(
    matchDetails: MatchDetail[],
    previousMatchDetails: Record<string, MatchDetail | null>,
  ): MatchDetail[] {
    // Separate players into their respective teams based on model color
    const { blueTeam, redTeam } = organizeTeams(matchDetails);

    // Retrieve current OpenSkill ratings for all players on both teams
    const blueRatings = blueTeam.map((match) =>
      this.getOrCreatePlayerRating(match.player.steamID),
    );
    const redRatings = redTeam.map((match) =>
      this.getOrCreatePlayerRating(match.player.steamID),
    );

    // Calculate average skill level for each team to determine balance
    const blueAvgSkill = this.calculateTeamSkill(blueRatings);
    const redAvgSkill = this.calculateTeamSkill(redRatings);
    const skillDifference = Math.abs(blueAvgSkill - redAvgSkill);

    // Determine which team won based on total frags/kills
    const winner = determineWinner(blueTeam, redTeam);

    // Analyze individual player performance relative to match averages
    const playerPerformances = new Map<string, PlayerPerformance>();
    matchDetails.forEach((player) => {
      const performance = calculateIndividualPerformance(player, matchDetails);
      playerPerformances.set(player.player.steamID, performance);
    });

    // Update OpenSkill ratings based on match outcome
    const newRatings =
      winner === 'blue'
        ? rate([blueRatings, redRatings], { rank: [1, 2] })
        : rate([blueRatings, redRatings], { rank: [2, 1] });

    // Cache the updated ratings for future matches
    [blueTeam, redTeam].forEach((team, teamIdx) => {
      team.forEach((match, idx) => {
        const steamId = match.player.steamID;
        const newRating = newRatings[teamIdx]?.[idx];
        if (newRating) {
          this._playerRatings.set(steamId, newRating);
        }
      });
    });

    [blueTeam, redTeam].forEach((team, teamIdx) => {
      team.forEach((match, idx) => {
        const steamId = match.player.steamID;
        const previousMatchDetail = previousMatchDetails[steamId];
        const isFirstMatch = previousMatchDetail === null;

        const previousMMR = isFirstMatch
          ? 1000
          : previousMatchDetail.mmrAfterMatch;

        const isWinner =
          (winner === 'blue' && teamIdx === 0) ||
          (winner === 'red' && teamIdx === 1);

        const oldRating = teamIdx === 0 ? blueRatings[idx] : redRatings[idx];
        const newRating = newRatings[teamIdx]?.[idx];
        const performance = playerPerformances.get(steamId)!;

        // Base MMR change from OpenSkill rating adjustment
        const baseMMRChange = this.convertRatingChangeToMMR(
          oldRating,
          newRating,
        );

        // Performance-based adjustment (rewards individual play)
        const performanceAdjustment = calculatePerformanceAdjustment(
          performance,
          isWinner,
          team.length,
        );

        // Balance factor adjusts MMR changes based on expected vs actual outcomes
        const balanceFactor = this.calculateBalanceFactor(
          skillDifference,
          isWinner,
          teamIdx === 0 ? blueAvgSkill : redAvgSkill,
          teamIdx === 0 ? redAvgSkill : blueAvgSkill,
        );

        // Carry adjustment rewards players who outperform teammates
        const carryAdjustment = this.calculateCarryAdjustment(
          match,
          team,
          performance,
          isWinner,
        );

        // Store total adjustment for debugging/transparency
        performance.adjustment = performanceAdjustment + carryAdjustment;

        // Combine all factors to get final MMR change
        const mmrDelta = Math.round(
          (baseMMRChange + performanceAdjustment + carryAdjustment) *
            balanceFactor,
        );

        // Apply bounds to prevent extreme MMR changes and ensure minimum movement
        const clampedMMRDelta = this.clampMMRDelta(mmrDelta, isWinner);
        const mmrAfterMatch = Math.max(0, previousMMR + clampedMMRDelta);

        // Update the match detail with calculated MMR values
        match.mmrAfterMatch = mmrAfterMatch;
        match.mmrDelta = isFirstMatch ? mmrAfterMatch : clampedMMRDelta;
      });
    });

    return matchDetails;
  }

  /**
   * Calculates carry/burden adjustment based on performance disparity within a team
   *
   * This system rewards players who:
   * - Perform well despite having weak teammates (reduces MMR loss on defeat)
   * - Carry their team to victory (small bonus MMR gain)
   *
   * And penalizes players who:
   * - Get carried to victory by strong teammates (reduces MMR gain)
   * - Perform poorly and drag down their team (increases MMR loss)
   *
   * @param playerMatch - The individual player's match data
   * @param team - All teammates' match data (including the player)
   * @param playerPerformance - The player's calculated performance metrics
   * @param isWinner - Whether the player's team won
   * @returns MMR adjustment value (positive = bonus, negative = penalty)
   */
  private calculateCarryAdjustment(
    playerMatch: MatchDetail,
    team: MatchDetail[],
    playerPerformance: PlayerPerformance,
    isWinner: boolean,
  ): number {
    // No carry mechanics in 1v1 scenarios
    if (team.length < 2) return 0;

    // Calculate performance metrics for all teammates except the current player
    const teammates = team.filter(
      (t) => t.player.steamID !== playerMatch.player.steamID,
    );

    // Calculate performance scores for all teammates using the same algorithm
    const teammatePerformances = teammates.map((teammate) => {
      // Get all match details for performance calculation context
      const allMatchDetails = [...team, ...teammates];
      return calculateIndividualPerformance(teammate, allMatchDetails);
    });

    // Compute average performance score of teammates for comparison
    const teammateAvgPerformance =
      teammatePerformances.reduce((sum, perf) => sum + perf.score, 0) /
      teammatePerformances.length;

    // Measure how much better/worse the player performed vs teammates
    const performanceDifference =
      playerPerformance.score - teammateAvgPerformance;

    // Only apply adjustment if there's a significant performance gap (>0.4 performance score difference)
    // This threshold accounts for the normalized performance scores (typically 0.2-2.5 range)
    if (Math.abs(performanceDifference) < 0.4) return 0;

    let carryAdjustment = 0;

    if (performanceDifference > 0.4) {
      // Player significantly outperformed teammates
      if (!isWinner) {
        // Lost despite strong individual performance - reduce MMR loss
        // Scale adjustment based on performance gap (max 18 points)
        carryAdjustment = Math.min(18, performanceDifference * 12);
      } else {
        // Won with strong performance - small additional bonus
        // Smaller bonus to prevent MMR inflation (max 8 points)
        carryAdjustment = Math.min(8, performanceDifference * 4);
      }
    } else if (performanceDifference < -0.4) {
      // Player significantly underperformed compared to teammates
      if (isWinner) {
        // Won despite poor performance (got carried) - reduce MMR gain
        // Penalty scales with performance gap (max -12 points)
        carryAdjustment = Math.max(-12, performanceDifference * 8);
      } else {
        // Lost with poor performance - increase MMR loss
        // Additional penalty for poor performance (max -10 points)
        carryAdjustment = Math.max(-10, performanceDifference * 6);
      }
    }

    return Math.round(carryAdjustment);
  }

  /**
   * Converts OpenSkill rating changes to MMR point changes
   *
   * OpenSkill ratings use mu (skill estimate) and sigma (uncertainty) values.
   * This method translates those changes into user-friendly MMR points.
   *
   * @param oldRating - Player's rating before the match
   * @param newRating - Player's rating after the match
   * @returns MMR point change (can be positive or negative)
   */
  private convertRatingChangeToMMR(
    oldRating: Rating,
    newRating: Rating,
  ): number {
    // Primary factor: change in skill estimate (mu)
    const muChange = newRating.mu - oldRating.mu;

    // Secondary factor: reduction in uncertainty (sigma) is rewarded
    // As players play more matches, their rating becomes more certain
    const sigmaReduction = Math.max(0, oldRating.sigma - newRating.sigma);

    // Convert to MMR points with conservative multipliers for stability
    // Reduced multiplier (5 instead of 8) prevents volatile MMR swings
    return muChange * 5 + sigmaReduction * 1.5;
  }

  /**
   * Calculates the average skill level of a team
   *
   * @param ratings - Array of OpenSkill Rating objects for team members
   * @returns Average mu (skill estimate) value for the team
   */
  private calculateTeamSkill(ratings: Rating[]): number {
    const totalMu = ratings.reduce((sum, rating) => sum + rating.mu, 0);
    return totalMu / ratings.length;
  }

  /**
   * Calculates a balance factor that adjusts MMR changes based on match fairness
   *
   * This system:
   * - Increases MMR changes when upsets occur (weaker team beats stronger team)
   * - Decreases MMR changes when expected outcomes happen with large skill gaps
   * - Helps prevent MMR inflation/deflation in unbalanced matches
   *
   * @param skillDifference - Absolute difference in average team skill
   * @param isWinner - Whether the player won
   * @param playerTeamSkill - Average skill of player's team
   * @param opponentTeamSkill - Average skill of opposing team
   * @returns Multiplier factor for MMR changes (0.5 to 1.8 range)
   */
  private calculateBalanceFactor(
    skillDifference: number,
    isWinner: boolean,
    playerTeamSkill: number,
    opponentTeamSkill: number,
  ): number {
    // Default factor - no adjustment for balanced matches
    let factor = 1.0;

    // Only adjust for significantly unbalanced matches (>3 skill point difference)
    if (skillDifference > 3) {
      // Determine if this was an upset (weaker team winning)
      const isUpset =
        (isWinner && playerTeamSkill < opponentTeamSkill) ||
        (!isWinner && playerTeamSkill > opponentTeamSkill);

      if (isUpset) {
        // Upset victory/noble defeat: amplify MMR changes
        factor = 1.3 + Math.min(0.4, skillDifference / 10);
      } else {
        // Expected outcome: reduce MMR changes slightly
        factor = 0.8 - Math.min(0.2, skillDifference / 15);
      }
    }

    // Prevent extreme multipliers that could break the system
    return Math.max(0.5, Math.min(1.8, factor));
  }

  /**
   * Applies minimum and maximum bounds to MMR changes
   *
   * Ensures that:
   * - Winners always gain at least some MMR (minimum +2)
   * - Losers always lose at least some MMR (minimum -2)
   * - MMR changes never exceed reasonable bounds (±40 points)
   *
   * @param mmrDelta - Calculated MMR change before clamping
   * @param isWinner - Whether the player won the match
   * @returns Clamped MMR delta within acceptable bounds
   */
  private clampMMRDelta(mmrDelta: number, isWinner: boolean): number {
    if (isWinner) {
      // Winners must gain at least 2 MMR, but no more than 40
      return Math.max(2, Math.min(40, mmrDelta));
    } else {
      // Losers must lose at least 2 MMR, but no more than 40
      return Math.max(-40, Math.min(-2, mmrDelta));
    }
  }

  /**
   * Retrieves existing player rating or creates initial rating for new players
   *
   * All new players start with standard OpenSkill defaults.
   *
   * @param steamID - Unique player identifier
   * @returns OpenSkill Rating object for the player
   */
  private getOrCreatePlayerRating(steamID: string): Rating {
    if (!this._playerRatings.has(steamID)) {
      const initialRating = rating({ mu: 25.0, sigma: 8.333 });
      this._playerRatings.set(steamID, initialRating);
    }
    return this._playerRatings.get(steamID)!;
  }
}
