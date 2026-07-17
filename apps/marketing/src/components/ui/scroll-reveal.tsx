import * as React from 'react';
import { cn } from '@hushbox/ui';

interface ScrollRevealProps extends React.ComponentProps<'div'> {
  animation?: 'fade-up' | 'fade-in' | 'slide-left' | 'slide-right';
  delay?: number;
}

function ScrollReveal({
  animation = 'fade-up',
  delay,
  className,
  style,
  ...props
}: Readonly<ScrollRevealProps>): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    /* v8 ignore next -- the ref is always attached to the div this component renders, so `el` is never null when the effect runs; the guard is defensive only. */
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.dataset.visible = 'true';
          observer.unobserve(el);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(el);
    return (): void => {
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      data-slot="scroll-reveal"
      data-animation={animation}
      data-visible="false"
      className={cn('transition-all duration-700 ease-out', className)}
      style={{
        ...style,
        ...(delay !== undefined && { '--reveal-delay': `${String(delay)}ms` }),
      }}
      {...props}
    />
  );
}

export { ScrollReveal, type ScrollRevealProps };
