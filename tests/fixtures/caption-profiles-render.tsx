import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { TimelineComposition } from '../../src/components/TimelineComposition';
import type { ProjectVideoProps } from '../../src/lib/project-props';
import type { TimelineIR } from '../../src/types/timeline';
const props: ProjectVideoProps & {timeline:TimelineIR}={projectId:'test',format:'vertical',productName:'Caption fixture',tagline:'',accentColor:'#FFE600',bgColor:'#203040',textColor:'#FFFFFF',scenes:[],voiceoverEnabled:true,musicVolume:0,timeline:{version:1,projectId:'test',timebase:{num:30,den:1},tracks:[]}};
registerRoot(()=> <Composition id="CaptionProfiles" component={TimelineComposition} width={1080} height={1920} fps={30} durationInFrames={90} defaultProps={props}/>);
