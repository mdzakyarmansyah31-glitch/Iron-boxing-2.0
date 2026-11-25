import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowLeftRight,
  BarChart3,
  Shuffle,
  Star,
  Swords,
  X,
} from 'lucide-react';
import { PLAYABLE_FIGHTERS } from '../data/fighters';
import { soundEngine } from '../engine/audio';
import { BoxerStats, FighterProfile } from '../types/game';
import { FighterPortrait } from './FighterPortrait';

interface FreeFightSelectProps {
  leftFighter: FighterProfile;
  rightFighter: FighterProfile;
  rounds: number;
  onSelectLeft: (fighter: FighterProfile) => void;
  onSelectRight: (fighter: FighterProfile) => void;
  onChangeRounds: (rounds: number) => void;
  onSwapCorners: () => void;
  onStartFight: () => void;
  onBack: () => void;
}

function getStarRating(stats: BoxerStats): number {
  const ovr =
    (stats.power + stats.speed + stats.defense + stats.footwork + stats.stamina + stats.chin) /
    6;
  return Math.max(3, Math.min(5, Math.round((ovr - 62) / 6) / 2 + 3));
}

function renderStars(rating: number, colorClass: string) {
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    const filled = i <= Math.round(rating);
    stars.push(
      <Star
        key={i}
        className={`w-3 h-3 sm:w-3.5 sm:h-3.5 ${
          filled ? `${colorClass} fill-current` : 'text-slate-600'
        }`}
      />,
    );
  }
  return stars;
}

export const FreeFightSelect: React.FC<FreeFightSelectProps> = ({
  leftFighter,
  rightFighter,
  rounds,
  onSelectLeft,
  onSelectRight,
  onChangeRounds,
  onSwapCorners,
  onStartFight,
  onBack,
}) => {
  const [showStatsModal, setShowStatsModal] = useState(false);

  const leftOverall = useMemo(() => {
    const s = leftFighter.baseStats;
    return Math.round((s.power + s.speed + s.defense + s.footwork + s.stamina + s.chin) / 6);
  }, [leftFighter]);

  const rightOverall = useMemo(() => {
    const s = rightFighter.baseStats;
    return Math.round((s.power + s.speed + s.defense + s.footwork + s.stamina + s.chin) / 6);
  }, [rightFighter]);

  const leftStars = getStarRating(leftFighter.baseStats);
  const rightStars = getStarRating(rightFighter.baseStats);

  const handleRandomize = () => {
    soundEngine.playUiClick();
    const a = PLAYABLE_FIGHTERS[Math.floor(Math.random() * PLAYABLE_FIGHTERS.length)];
    let b = PLAYABLE_FIGHTERS[Math.floor(Math.random() * PLAYABLE_FIGHTERS.length)];
    if (PLAYABLE_FIGHTERS.length > 1 && b.id === a.id) {
      b =
        PLAYABLE_FIGHTERS[
          (PLAYABLE_FIGHTERS.findIndex((f) => f.id === a.id) + 1) % PLAYABLE_FIGHTERS.length
        ];
    }
    onSelectLeft(a);
    onSelectRight(b);
  };

  return (
    <div
      className="fixed inset-0 z-20 flex flex-col justify-between pointer-events-none select-none overflow-hidden bg-gradient-to-b from-black/55 via-transparent to-black/92"
      style={{
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {/* Top Broadcast Banner */}
      <div className="flex items-center justify-between px-3 sm:px-8 pt-2.5 sm:pt-4 pointer-events-auto shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2 h-5 sm:h-6 bg-red-600 rounded-xs" />
          <div>
            <div className="font-display font-black text-lg sm:text-2xl tracking-wider text-white leading-none">
              FREE FIGHT
            </div>
            <div className="text-[9px] sm:text-xs text-slate-300 tracking-widest uppercase">
              20-Fighter Roster · Face-Off Selection
            </div>
          </div>
        </div>

        {/* Center Rounds Selector */}
        <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[#0d111a]/90 border border-white/15">
          <span className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider mr-1 hidden sm:inline">
            Rounds
          </span>
          {[1, 3, 5].map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                onChangeRounds(r);
              }}
              className={`px-2 py-0.5 rounded text-xs font-display font-bold tracking-wider transition-colors cursor-pointer ${
                rounds === r
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              {r}R
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            soundEngine.playUiClick();
            onBack();
          }}
          className="flex items-center gap-1.5 px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-lg bg-[#0d111a]/90 border border-white/15 text-xs font-semibold text-slate-200 hover:text-white hover:border-white/30 cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          <span>Menu</span>
        </button>
      </div>

      {/* Middle Left / Right Fighter Hero Readouts */}
      <div className="flex-1 min-h-0 flex items-end justify-between px-3 sm:px-8 pb-1.5 sm:pb-3 pointer-events-none">
        {/* Left Corner Fighter Info */}
        <div className="max-w-[44%] sm:max-w-[34%] bg-gradient-to-r from-[#090d16]/88 via-[#090d16]/65 to-transparent pl-2.5 pr-4 py-1.5 sm:py-2 border-l-4 border-red-500 rounded-r-lg">
          <div className="flex items-center gap-2 text-[9px] sm:text-xs font-bold tracking-widest uppercase text-red-400">
            <span>RED CORNER · YOU</span>
            <span className="font-mono-tabular text-white/90">OVR {leftOverall}</span>
          </div>
          <div className="font-display font-black text-lg sm:text-3xl lg:text-4xl text-white uppercase leading-none tracking-wide truncate mt-0.5">
            {leftFighter.name}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 sm:mt-1">
            <div className="flex items-center gap-0.5">{renderStars(leftStars, 'text-red-400')}</div>
            <span className="text-[10px] sm:text-xs text-slate-200 font-semibold uppercase tracking-wide truncate">
              {leftFighter.styleLabel}
            </span>
          </div>
          <div className="text-[10px] sm:text-[11px] text-slate-400 mt-0.5 hidden sm:block">
            “{leftFighter.nickname}” · {leftFighter.stance} · {leftFighter.origin}
          </div>
        </div>

        {/* Center Rounds Badge */}
        <div className="hidden md:flex flex-col items-center justify-end pb-1">
          <div className="px-3 py-1 rounded bg-black/65 border border-white/15 text-[10px] font-bold tracking-[0.22em] text-slate-300 uppercase mb-1">
            HEAVYWEIGHT · {rounds} ROUNDS
          </div>
        </div>

        {/* Right Corner Opponent Info */}
        <div className="max-w-[44%] sm:max-w-[34%] bg-gradient-to-l from-[#090d16]/88 via-[#090d16]/65 to-transparent pr-2.5 pl-4 py-1.5 sm:py-2 border-r-4 border-sky-500 rounded-l-lg text-right">
          <div className="flex items-center justify-end gap-2 text-[9px] sm:text-xs font-bold tracking-widest uppercase text-sky-400">
            <span className="font-mono-tabular text-white/90">OVR {rightOverall}</span>
            <span>BLUE CORNER · CPU</span>
          </div>
          <div className="font-display font-black text-lg sm:text-3xl lg:text-4xl text-white uppercase leading-none tracking-wide truncate mt-0.5">
            {rightFighter.name}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 mt-0.5 sm:mt-1">
            <span className="text-[10px] sm:text-xs text-slate-200 font-semibold uppercase tracking-wide truncate">
              {rightFighter.styleLabel}
            </span>
            <div className="flex items-center gap-0.5">{renderStars(rightStars, 'text-sky-400')}</div>
          </div>
          <div className="text-[10px] sm:text-[11px] text-slate-400 mt-0.5 hidden sm:block">
            {rightFighter.origin} · {rightFighter.stance} · “{rightFighter.nickname}”
          </div>
        </div>
      </div>

      {/* Bottom Dual 20-Fighter Portrait Grids + VS Crest + Footer Bar */}
      <div className="pointer-events-auto max-h-[56vh] sm:max-h-none overflow-y-auto bg-[#070a11]/94 border-t border-white/12 px-3 sm:px-6 pt-1.5 pb-2.5 sm:pb-3 shrink-0">
        <div className="max-w-7xl mx-auto">
          {/* Labels Row */}
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4 mb-1">
            <div className="flex items-center justify-between text-[9px] sm:text-[10px] font-bold tracking-widest uppercase text-slate-400">
              <span className="text-red-400">ALL FIGHTERS (20)</span>
              <span className="hidden sm:inline">SELECT YOUR BOXER</span>
            </div>
            <div className="w-8 sm:w-12" />
            <div className="flex items-center justify-between text-[9px] sm:text-[10px] font-bold tracking-widest uppercase text-slate-400">
              <span className="hidden sm:inline">SELECT CPU OPPONENT</span>
              <span className="text-sky-400 ml-auto">ALL FIGHTERS (20)</span>
            </div>
          </div>

          {/* Dual 10x2 Portrait Grids flanking VS Crest */}
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4">
            {/* LEFT 20-FIGHTER GRID */}
            <div className="grid grid-cols-10 gap-0.5 sm:gap-1">
              {PLAYABLE_FIGHTERS.map((f) => {
                const selected = f.id === leftFighter.id;
                return (
                  <button
                    key={`L-${f.id}`}
                    type="button"
                    title={`${f.name} — ${f.styleLabel}`}
                    onClick={() => {
                      soundEngine.playUiClick();
                      onSelectLeft(f);
                    }}
                    className={`relative group h-8 sm:h-auto sm:aspect-square rounded-xs sm:rounded-sm overflow-hidden border transition-transform cursor-pointer ${
                      selected
                        ? 'border-2 border-red-500 ring-1 sm:ring-2 ring-red-500/50 scale-105 z-10'
                        : 'border-white/15 hover:border-white/55 opacity-85 hover:opacity-100'
                    }`}
                  >
                    <FighterPortrait
                      skinColor={f.appearance.skinColor}
                      hairStyle={f.appearance.hairStyle}
                      hairColor={f.appearance.hairColor}
                      beardStyle={f.appearance.beardStyle}
                      trunksColor={f.appearance.trunksColor}
                      className="w-full h-full block"
                    />
                    <div className="absolute inset-x-0 bottom-0 bg-black/75 px-0.5 py-[1px] text-[7px] sm:text-[8px] leading-none font-bold text-white truncate text-center">
                      {f.name.split(' ')[1] ?? f.name}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* CENTER VS CREST */}
            <div className="flex flex-col items-center justify-center px-0.5 sm:px-1">
              <div className="w-8 h-8 sm:w-12 sm:h-12 rounded-full bg-gradient-to-br from-red-600 via-amber-500 to-sky-600 p-[2px] shadow-[0_0_20px_rgba(239,68,68,0.45)]">
                <div className="w-full h-full rounded-full bg-[#090d16] flex items-center justify-center">
                  <span className="font-display font-black italic text-xs sm:text-xl text-white tracking-tighter">
                    VS
                  </span>
                </div>
              </div>
            </div>

            {/* RIGHT 20-FIGHTER GRID */}
            <div className="grid grid-cols-10 gap-0.5 sm:gap-1">
              {PLAYABLE_FIGHTERS.map((f) => {
                const selected = f.id === rightFighter.id;
                return (
                  <button
                    key={`R-${f.id}`}
                    type="button"
                    title={`${f.name} — ${f.styleLabel}`}
                    onClick={() => {
                      soundEngine.playUiClick();
                      onSelectRight(f);
                    }}
                    className={`relative group h-8 sm:h-auto sm:aspect-square rounded-xs sm:rounded-sm overflow-hidden border transition-transform cursor-pointer ${
                      selected
                        ? 'border-2 border-sky-400 ring-1 sm:ring-2 ring-sky-400/50 scale-105 z-10'
                        : 'border-white/15 hover:border-white/55 opacity-85 hover:opacity-100'
                    }`}
                  >
                    <FighterPortrait
                      skinColor={f.appearance.skinColor}
                      hairStyle={f.appearance.hairStyle}
                      hairColor={f.appearance.hairColor}
                      beardStyle={f.appearance.beardStyle}
                      trunksColor={f.appearance.trunksColor}
                      className="w-full h-full block"
                    />
                    <div className="absolute inset-x-0 bottom-0 bg-black/75 px-0.5 py-[1px] text-[7px] sm:text-[8px] leading-none font-bold text-white truncate text-center">
                      {f.name.split(' ')[1] ?? f.name}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Footer Action Bar */}
          <div className="flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-white/10">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  onSwapCorners();
                }}
                className="flex items-center gap-1 px-2 py-1 sm:px-2.5 sm:py-1.5 rounded-md bg-white/[0.06] hover:bg-white/[0.12] border border-white/12 text-[11px] sm:text-xs font-semibold text-slate-200 cursor-pointer"
              >
                <ArrowLeftRight className="w-3.5 h-3.5 text-amber-400" />
                <span className="hidden sm:inline">Change Corner</span>
                <span className="sm:hidden">Swap</span>
              </button>

              <button
                type="button"
                onClick={handleRandomize}
                className="flex items-center gap-1 px-2 py-1 sm:px-2.5 sm:py-1.5 rounded-md bg-white/[0.06] hover:bg-white/[0.12] border border-white/12 text-[11px] sm:text-xs font-semibold text-slate-200 cursor-pointer"
              >
                <Shuffle className="w-3.5 h-3.5 text-sky-400" />
                <span>Random</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playUiClick();
                  setShowStatsModal(true);
                }}
                className="flex items-center gap-1 px-2 py-1 sm:px-2.5 sm:py-1.5 rounded-md bg-white/[0.06] hover:bg-white/[0.12] border border-white/12 text-[11px] sm:text-xs font-semibold text-slate-200 cursor-pointer"
              >
                <BarChart3 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Stats</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                soundEngine.playUiClick();
                onStartFight();
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 sm:px-6 sm:py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-display font-black text-sm sm:text-xl tracking-wider shadow-[0_0_20px_rgba(220,38,38,0.45)] transition-colors cursor-pointer shrink-0"
            >
              <Swords className="w-4 h-4 sm:w-5 sm:h-5" />
              <span>FIGHT NOW</span>
            </button>
          </div>
        </div>
      </div>

      {/* Tale of the Tape Stats Modal */}
      {showStatsModal && (
        <div className="fixed inset-0 z-30 bg-black/75 flex items-center justify-center p-4 pointer-events-auto">
          <div className="w-full max-w-lg bg-[#0d121c] border border-white/15 rounded-xl p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-4">
              <h3 className="font-display font-extrabold text-2xl text-white tracking-wide">
                TALE OF THE TAPE
              </h3>
              <button
                type="button"
                onClick={() => setShowStatsModal(false)}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-3 text-center text-xs font-bold pb-2 border-b border-white/10 mb-3">
              <div className="text-red-400 truncate">{leftFighter.name}</div>
              <div className="text-slate-500">ATTRIBUTE</div>
              <div className="text-sky-400 truncate">{rightFighter.name}</div>
            </div>

            <div className="space-y-2 text-xs">
              {(
                [
                  ['Height', leftFighter.heightDisplay, rightFighter.heightDisplay],
                  ['Weight', leftFighter.weightDisplay, rightFighter.weightDisplay],
                  ['Reach', leftFighter.reachDisplay, rightFighter.reachDisplay],
                  ['Stance', leftFighter.stance, rightFighter.stance],
                ] as const
              ).map(([label, lv, rv]) => (
                <div key={label} className="grid grid-cols-3 text-center py-1 bg-white/[0.02] rounded">
                  <span className="text-white font-semibold">{lv}</span>
                  <span className="text-slate-400">{label}</span>
                  <span className="text-white font-semibold">{rv}</span>
                </div>
              ))}

              {(
                [
                  ['Power', leftFighter.baseStats.power, rightFighter.baseStats.power],
                  ['Speed', leftFighter.baseStats.speed, rightFighter.baseStats.speed],
                  ['Defense', leftFighter.baseStats.defense, rightFighter.baseStats.defense],
                  ['Footwork', leftFighter.baseStats.footwork, rightFighter.baseStats.footwork],
                  ['Stamina', leftFighter.baseStats.stamina, rightFighter.baseStats.stamina],
                  ['Chin', leftFighter.baseStats.chin, rightFighter.baseStats.chin],
                ] as const
              ).map(([label, lv, rv]) => (
                <div key={label} className="grid grid-cols-3 items-center text-center py-0.5 font-mono-tabular">
                  <span className={lv >= rv ? 'text-red-300 font-bold' : 'text-slate-400'}>{lv}</span>
                  <span className="font-sans text-slate-400">{label}</span>
                  <span className={rv >= lv ? 'text-sky-300 font-bold' : 'text-slate-400'}>{rv}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
                                     
