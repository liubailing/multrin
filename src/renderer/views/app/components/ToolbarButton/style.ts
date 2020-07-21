import styled, { css } from 'styled-components';

import { TOOLBAR_BUTTON_WIDTH } from '~/renderer/views/app/constants';
import { centerIcon } from '~/shared/mixins';

export const Icon = styled.div`
  width: 100%;
  height: 100%;
  will-change: background-image;
  transition: 0.15s background-image, 0.2s filter;
  filter: ${(props: any) => (props.theme.dark ? 'invert(100%)' : 'none')};

  ${({
    size,
    disabled,
    icon,
    opacity,
  }: {
    size: number;
    disabled: boolean;
    icon: string;
    opacity: number;
  }) => css`
    ${centerIcon(size)};
    opacity: ${disabled ? 0.25 : opacity};
    background-image: url(${icon});
  `};
`;

export const Button = styled.div`
  height: 100%;
  -webkit-app-region: no-drag;
  position: relative;
  transition: 0.2s background-color;
  width: ${TOOLBAR_BUTTON_WIDTH}px;
  ${({ disabled }: { disabled: boolean }) => css`
    pointer-events: ${disabled ? 'none' : 'auto'};
  `};
`;

export const Circle = styled.div`
  border-radius: 50%;
  width: 32px;
  height: 32px;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  overflow: hidden;
  transition: 0.2s background-color;
  &:hover {
    background-color: ${(props: any) =>
      props.theme.dark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.06)'};
  }
`;
