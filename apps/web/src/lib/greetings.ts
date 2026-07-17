import { getSecureRandomElement } from '@hushbox/shared';

export interface Greeting {
  title: string;
  subtitle: string;
}

const NEW_USER_GREETINGS: Greeting[] = [
  { title: 'Welcome to HushBox', subtitle: 'One interface. Every feature.' },
  { title: 'First time here?', subtitle: 'Good timing' },
  { title: 'HushBox', subtitle: 'Private.' },
  { title: 'Welcome in', subtitle: 'Claude, GPT, Gemini—take your pick' },
  { title: "Let's go", subtitle: 'Ask something interesting' },
];

const MORNING_GREETINGS: Greeting[] = [
  { title: 'Good morning', subtitle: 'Early starts lead somewhere' },
  { title: 'Morning', subtitle: 'The day is wide open' },
  { title: 'Up early?', subtitle: 'Same' },
  { title: 'New day', subtitle: 'Blank slate energy' },
  { title: 'Morning', subtitle: 'What are we solving today?' },
];

const AFTERNOON_GREETINGS: Greeting[] = [
  { title: 'Afternoon', subtitle: 'Right in the thick of it' },
  { title: 'Hey', subtitle: 'Got something on your mind?' },
  { title: 'Afternoon', subtitle: 'Good time to figure something out' },
  { title: 'Hey there', subtitle: 'What are you working on?' },
  { title: 'Afternoon', subtitle: "Let's make something happen" },
];

const EVENING_GREETINGS: Greeting[] = [
  { title: 'Evening', subtitle: 'Wrapping up or just getting started?' },
  { title: 'Golden hour', subtitle: 'Some things click better at night' },
  { title: 'Evening', subtitle: 'The good ideas come out now' },
  { title: 'Hey', subtitle: 'Day winding down. Mind still going.' },
  { title: 'Evening', subtitle: 'What brought you here?' },
];

const NIGHT_GREETINGS: Greeting[] = [
  { title: 'Late night', subtitle: 'The interesting questions live here' },
  { title: 'Night owl', subtitle: 'Respect' },
  { title: "Can't sleep?", subtitle: 'Might as well think about something' },
  { title: 'After hours', subtitle: 'No distractions. Just you.' },
  { title: 'Late', subtitle: "What's on your mind?" },
];

function getRandomGreeting(greetings: Greeting[]): Greeting {
  /* v8 ignore start -- every caller passes a non-empty module-constant greeting array, so the empty-array guard is unreachable. */
  if (greetings.length === 0) {
    return { title: 'HushBox', subtitle: 'What do you need?' };
  }
  /* v8 ignore stop */
  return getSecureRandomElement(greetings);
}

function getBaseGreeting(isAuthenticated: boolean): Greeting {
  if (!isAuthenticated) {
    return getRandomGreeting(NEW_USER_GREETINGS);
  }

  const hour = new Date().getHours();

  if (hour >= 5 && hour < 12) {
    return getRandomGreeting(MORNING_GREETINGS);
  } else if (hour >= 12 && hour < 17) {
    return getRandomGreeting(AFTERNOON_GREETINGS);
  } else if (hour >= 17 && hour < 21) {
    return getRandomGreeting(EVENING_GREETINGS);
  } else {
    return getRandomGreeting(NIGHT_GREETINGS);
  }
}

export function getGreeting(isAuthenticated: boolean): Greeting {
  return getBaseGreeting(isAuthenticated);
}
