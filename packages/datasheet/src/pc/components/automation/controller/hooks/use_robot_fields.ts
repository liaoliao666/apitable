import { useAtomValue } from 'jotai';
import { useEffect, useMemo } from 'react';
import { useSelector } from 'react-redux';
import {IReduxState, Selectors, StoreActions} from '@apitable/core';
import { useAppDispatch } from 'pc/hooks/use_app_dispatch';
import { useAllFieldsByDstId } from '../../../robot/hooks';
import { AutomationScenario, IRobotTrigger } from '../../../robot/interface';
import { automationStateAtom, automationTriggerAtom, loadableFormMeta } from '../index';

export const getDatasheetId = (trigger?: Pick<IRobotTrigger, 'input'>) => {
  if (!trigger) {
    return undefined;
  }

  const operands = trigger?.input?.value?.operands ?? [];

  if (operands.length === 0) {
    return undefined;
  }
  // @ts-ignore
  const f = operands.findIndex(item => item === 'datasheetId');
  if (f > -1) {
    return operands[f + 1].value;
  }
  return undefined;
};

export const getFormId = (trigger?: Pick<IRobotTrigger, 'input'>) => {

  if (!trigger) {
    return undefined;
  }
  const operands = trigger?.input?.value?.operands ?? [];

  if (operands.length === 0) {
    return undefined;
  }
  // @ts-ignore
  const f = operands.findIndex(item => item === 'formId');
  if (f > -1) {
    return operands[f + 1].value;
  }
  return undefined;
};

export const getRelativedId = (automationTrigger?: Pick<IRobotTrigger, 'input'>) => {
  if(!automationTrigger) {
    return null;
  }
  const formId = getFormId(automationTrigger);
  const datasheetId= getDatasheetId(automationTrigger);
  return formId ?? datasheetId;
};

export const useTriggerDatasheetId = (): string | undefined => {

  const automationState = useAtomValue(automationStateAtom);
  const automationTrigger = useAtomValue(automationTriggerAtom);

  const activeDatasheetId = useSelector(Selectors.getActiveDatasheetId);
  const data = useMemo(() => ({
    formId: getFormId(automationTrigger),
    datasheetId: getDatasheetId(automationTrigger)
  }), [automationTrigger]);

  const formMeta = useAtomValue(loadableFormMeta);

  const dispatch = useAppDispatch();
  useEffect(() => {
    // @ts-ignore
    const dId = formMeta?.data?.sourceInfo?.datasheetId;
    if (dId) {
      dispatch(StoreActions.fetchDatasheet(dId));
    }

  }, [dispatch, formMeta]);

  if (data.datasheetId) {
    return data.datasheetId;
  }

  if (automationState?.scenario === AutomationScenario.datasheet) {
    return activeDatasheetId;
  }
  // @ts-ignore
  return formMeta?.data?.sourceInfo?.datasheetId;
};

export const useAutomationRobotFields = (dstId: string) => {
  const fieldPermissionMap = useSelector((state: IReduxState) => {
    return Selectors.getFieldPermissionMap(state, dstId);
  });
  const fields = useAllFieldsByDstId(dstId);
  return { fields, fieldPermissionMap };
};
