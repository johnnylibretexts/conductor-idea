import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ideaAPI } from '../../../api/idea';
export function IdeaProjectLink({ projectID }: { projectID: string }) {
  const capability = useQuery({ queryKey: ['idea-capabilities', projectID], queryFn: () => ideaAPI(projectID).capabilities(), retry: false, cacheTime: 0 });
  return capability.data?.reviewEnabled ? <Link className="ui button" to={`/projects/${projectID}/idea`}>IDEA Review</Link> : null;
}
